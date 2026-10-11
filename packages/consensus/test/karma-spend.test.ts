import { describe, it, expect, vi } from 'vitest';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  LIKE_KARMA_COST,
  POST_PRICE_REPLY,
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  KarmaBox,
  UsernameBox,
} from '@dagsocial/types';
import { applyBlock, validateTx } from '@dagsocial/consensus';
import type { ApplyContext, UtxoEngineDeps } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  burnTx,
  candidateBlock,
  changeOf,
  claimTx,
  consolidateTx,
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
  uid,
  vouchTx,
  withdrawTx,
  writeEffects,
  type Built,
  type TestIdentity,
} from './helpers.js';

/**
 * NODE_INTERFACE → Karma transition rules: the two leads
 * "A karma spend is covered by effective karma, over the block's body as a whole"
 * and "Only a post spends the floor".
 *
 * `spend     = the summed value of the transaction's outputs that are not karma boxes`
 * `held      = the summed value of the owner's unspent karma boxes, through the overlay`
 * `owed      = face − effectiveKarma(face, record, height, decayCfg)` at pre-body state
 * `remaining = held − owed`
 *
 * A post is valid while `remaining ≥ spend`; every other spend while
 * `remaining − spend ≥ decayCfg.karmaMinimum` (NODE_INTERFACE → Karma transition rules).
 */

const PROFILE = profileFor('devnet');
const CTX: ApplyContext = {
  ...applyContextFor(PROFILE),
  decayCfg: { staleThresholdBlocks: 6, decayIntervalBlocks: 3, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM },
};
const H = 600;
const miner = seededIdentity('karma-spend/miner');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Seed {
  view: MemoryStateView;
  actor: TestIdentity;
}

/** A view with one actor, their karma, their record, the protocol boxes, and a seeded miner record. */
function seed(label: string, karmaValues: bigint[], recFields: Parameters<typeof identityRecord>[0]): Seed {
  const view = new MemoryStateView({ memberCount: 1 });
  const actor = seededIdentity(`karma-spend/${label}/actor`);
  view.putIdentityRecord(actor.userId, identityRecord(recFields));
  view.putIdentityRecord(miner.userId, identityRecord({ memberSinceBlock: 1 }));
  let nonce = 1;
  for (const value of karmaValues) view.insertBox(karmaBox(actor.userId, value, nonce++, 0));
  view.insertBox(protocolBox('emission', PROFILE.creditEmissionTotal, nonce++));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, nonce++));
  return { view, actor };
}

/** Add a confirmed post row and topology to the view. */
function putConfirmedPost(view: MemoryStateView, postId: string, author: Uint8Array): void {
  view.insertPost(postId);
  view.insertBlockTopology(postId, author, H - 1);
}

/** Expect `applyBlock` to refuse this body; the reason must name `tx`. */
function expectRefusedAt(seed: Seed, txs: Built[], tx: Built, phrase: string): void {
  const before = seed.view.digest();
  const block = candidateBlock(seed.view, H, txs, miner.userId, CTX);
  const result = applyBlock(seed.view, block, CTX);
  expect(result).toEqual({ ok: false, reason: expect.stringContaining(tx.txId) });
  expect(result).toEqual({ ok: false, reason: expect.stringContaining(phrase) });
  expect(seed.view.digest()).toBe(before);
}

/** Expect `applyBlock` to accept; the view mutates by the effects. */
function expectAccepted(seed: Seed, txs: Built[]): void {
  const block = candidateBlock(seed.view, H, txs, miner.userId, CTX);
  const result = applyBlock(seed.view, block, CTX);
  if (!result.ok) throw new Error(`block was refused: ${result.reason}`);
  writeEffects(seed.view, result.effects, H);
}

/** The total face karma an owner holds in the view, summed over their live karma boxes. */
function karmaFaceOf(view: MemoryStateView, owner: Uint8Array): bigint {
  return view.getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n);
}

const POST_RULE = 'exceeds what remains of the owner\'s effective karma';
const FLOOR_RULE = 'below the floor of 10';

// ---------------------------------------------------------------------------
// A stale identity and a fresh one, each of face 1000
// ---------------------------------------------------------------------------

describe('karma spend rule, a stale identity and a fresh one, each of face 1000', () => {
  // A stale root, face 1000, effective 10; one bond of 250 refused at the 1st.
  it('a stale root with effective 10 cannot afford a bond of 250', () => {
    const s = seed('stale-bond-250', [1000n], { memberSinceBlock: 1, lastActivityBlock: 1 });
    const invite = inviteTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, seededIdentity('stale-bond-250/invitee').userId, 250n, H);
    expectRefusedAt(s, [invite], invite, FLOOR_RULE);
  });

  // The same root; 99 bonds of 10, each spending the change of the one before.
  it('a stale root with effective 10 cannot afford even one bond of 10', () => {
    const s = seed('stale-bond-10', [1000n], { memberSinceBlock: 1, lastActivityBlock: 1 });
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 99; i++) {
      const tx = inviteTx(s.actor, input, seededIdentity(`stale-bond-10/invitee/${i}`).userId, 10n, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectRefusedAt(s, txs, txs[0]!, FLOOR_RULE);
  });

  // Face 1000, lastDecayBlock 360 so owed is 400 and effective is 600; three bonds of 250.
  // Pre-body remaining = 600. Bond 1: 600 - 250 = 350 >= 10 ✓. Bond 2: 350 - 250 = 100 >= 10 ✓.
  // Bond 3: 100 - 250 = -150 < 10 → refused at the third. After a body of two the inviter holds 100
  // (settlement burns 400 to the pool from the 500 face left in the body).
  it('face 1000 effective 600 — the first two bonds valid, the third refused', () => {
    const s = seed('bonds-250', [1000n], { memberSinceBlock: 1, lastActivityBlock: 1, lastDecayBlock: 360 });
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 3; i++) {
      const tx = inviteTx(s.actor, input, seededIdentity(`bonds-250/invitee/${i}`).userId, 250n, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectRefusedAt(s, txs, txs[2]!, FLOOR_RULE);
  });

  it('a body of two bonds of 250 settles the inviter at 100 and burns 400 to the pool', () => {
    const s = seed('bonds-250-settles', [1000n], { memberSinceBlock: 1, lastActivityBlock: 1, lastDecayBlock: 360 });
    const poolBefore = s.view.getKarmaPoolBox()!.value;
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 2; i++) {
      const tx = inviteTx(s.actor, input, seededIdentity(`bonds-250-settles/invitee/${i}`).userId, 250n, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectAccepted(s, txs);
    expect(karmaFaceOf(s.view, s.actor.userId)).toBe(100n);
    expect(s.view.getKarmaPoolBox()!.value - poolBefore).toBe(400n - 2n * 250n); // 2 bonds drawn, 400 burned
  });

  // A stale identity, face 1000, effective 10; a like refused at the 1st.
  it('a stale identity with effective 10 cannot afford one like', () => {
    const s = seed('stale-like', [1000n], { lastActivityBlock: 1 });
    const authorKey = seededIdentity('stale-like/author').userId;
    const postId = hex(uid('stale-like/post'));
    putConfirmedPost(s.view, postId, authorKey);
    const like = likeTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, postId, authorKey, H);
    expectRefusedAt(s, [like], like, FLOOR_RULE);
  });

  // A fresh identity, face 1000; 990 likes accepted, a 991st refused. The 990 likes
  // leave the liker 10, pay the author 792 and add 198 to the karma pool.
  it('a fresh identity with face 1000 — 990 likes accepted', () => {
    const s = seed('fresh-990', [1000n], { lastActivityBlock: H - 1 });
    const authorKey = seededIdentity('fresh-990/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const poolBefore = s.view.getKarmaPoolBox()!.value;
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 990; i++) {
      const postId = hex(uid(`fresh-990/post/${i}`));
      putConfirmedPost(s.view, postId, authorKey);
      const tx = likeTx(s.actor, input, postId, authorKey, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectAccepted(s, txs);
    expect(karmaFaceOf(s.view, s.actor.userId)).toBe(10n);
    expect(karmaFaceOf(s.view, authorKey)).toBe(792n);
    expect(s.view.getKarmaPoolBox()!.value - poolBefore).toBe(198n);
  });

  it('a fresh identity with face 1000 — a 991st like refused', () => {
    const s = seed('fresh-991', [1000n], { lastActivityBlock: H - 1 });
    const authorKey = seededIdentity('fresh-991/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 991; i++) {
      const postId = hex(uid(`fresh-991/post/${i}`));
      putConfirmedPost(s.view, postId, authorKey);
      const tx = likeTx(s.actor, input, postId, authorKey, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectRefusedAt(s, txs, txs[990]!, FLOOR_RULE);
  });
});

// ---------------------------------------------------------------------------
// Above the floor, likes
// ---------------------------------------------------------------------------

describe('above the floor, likes', () => {
  // face 1000, lastDecayBlock 360: owed 400, effective 600, remaining pre-body 600.
  // Like k (1-indexed): remaining - 1 = 600 - k. 590 at k=590. 591st falls to 9 < 10.
  it('effective 600 — 590 likes valid, the 591st refused', () => {
    const s = seed('above-floor-591', [1000n], { lastActivityBlock: 1, lastDecayBlock: 360 });
    const authorKey = seededIdentity('above-floor/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 591; i++) {
      const postId = hex(uid(`above-floor/post/${i}`));
      putConfirmedPost(s.view, postId, authorKey);
      const tx = likeTx(s.actor, input, postId, authorKey, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectRefusedAt(s, txs, txs[590]!, FLOOR_RULE);
  });

  it('effective 600 — a body of 590 likes is accepted', () => {
    const s = seed('above-floor-590', [1000n], { lastActivityBlock: 1, lastDecayBlock: 360 });
    const authorKey = seededIdentity('above-floor590/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 590; i++) {
      const postId = hex(uid(`above-floor590/post/${i}`));
      putConfirmedPost(s.view, postId, authorKey);
      const tx = likeTx(s.actor, input, postId, authorKey, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectAccepted(s, txs);
  });
});

// ---------------------------------------------------------------------------
// Posts at the floor
// ---------------------------------------------------------------------------

describe('a post at the floor', () => {
  // A stale identity face 1000 effective 10. Pre-body remaining = 10.
  // Thread 1 (spend 5): 10 >= 5 ✓, change = 995, held after = 995.
  // Thread 2 (spend 5): held = 995, owed_pre = 990, remaining = 5, 5 >= 5 ✓, change = 990.
  // Thread 3 (spend 5): held = 990, remaining = 0, 0 < 5 → refused with the post rule.
  it('stale effective 10 — a third thread is refused with the post rule', () => {
    const s = seed('post-floor-3', [1000n], { lastActivityBlock: 1 });
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 3; i++) {
      const tx = threadTx(s.actor, input, `thread ${i}`, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectRefusedAt(s, txs, txs[2]!, POST_RULE);
  });

  it('stale effective 10 — two threads are accepted', () => {
    const s = seed('post-floor-2', [1000n], { lastActivityBlock: 1 });
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (let i = 0; i < 2; i++) {
      const tx = threadTx(s.actor, input, `thread ${i}`, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectAccepted(s, txs);
  });

  it('stale effective 10 — one thread is accepted', () => {
    const s = seed('post-floor-1', [1000n], { lastActivityBlock: 1 });
    const tx = threadTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'one thread', H);
    expectAccepted(s, [tx]);
  });

  // After the thread the owner has remaining 5 (held 995, owed 990). A like's floor is 10,
  // so the like is refused — only a post spends the floor.
  it('stale effective 10 — a thread then a like, the like refused', () => {
    const s = seed('post-then-like', [1000n], { lastActivityBlock: 1 });
    const authorKey = seededIdentity('post-then-like/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const postId = hex(uid('post-then-like/post'));
    putConfirmedPost(s.view, postId, authorKey);
    const thread = threadTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'opens', H);
    const like = likeTx(s.actor, changeOf(thread), postId, authorKey, H);
    expectRefusedAt(s, [thread, like], like, FLOOR_RULE);
  });

  // After the thread remaining is 5 and a reply spends 3 (post rule, 5 >= 3 ✓).
  it('stale effective 10 — a thread then a reply, both accepted', () => {
    const s = seed('post-then-reply', [1000n], { lastActivityBlock: 1 });
    const parent = seededIdentity('post-then-reply/parent-author');
    s.view.putIdentityRecord(parent.userId, identityRecord({ lastActivityBlock: H - 1 }));
    const parentPostId = hex(uid('post-then-reply/parent'));
    putConfirmedPost(s.view, parentPostId, parent.userId);
    const thread = threadTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'opens', H);
    const reply = replyTx(s.actor, changeOf(thread), 'reply', parentPostId, parent.userId, H);
    expectAccepted(s, [thread, reply]);
  });
});

// ---------------------------------------------------------------------------
// The settlement of a stale identity's thread
// ---------------------------------------------------------------------------

describe('the settlement of a stale identity\'s thread', () => {
  it('a stale identity, face 1000 effective 10 — one thread leaves 10 and burns 985', () => {
    const s = seed('settle-thread', [1000n], { lastActivityBlock: 1 });
    const poolBefore = s.view.getKarmaPoolBox()!.value;
    const thread = threadTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'opens', H);
    expectAccepted(s, [thread]);
    expect(karmaFaceOf(s.view, s.actor.userId)).toBe(10n);
    // Settlement draws POST_PRICE_THREAD from karma_price into the pool, then burns 985.
    expect(s.view.getKarmaPoolBox()!.value - poolBefore).toBe(POST_PRICE_THREAD + 985n);
  });
});

// ---------------------------------------------------------------------------
// Each arm, each side of its line, a fresh identity
// ---------------------------------------------------------------------------

describe('each arm — a fresh identity, each side of its line', () => {
  // like at 11 valid, like at 10 refused (fresh, owed 0, floor 10, spend 1)
  it('like at 11 — accepted', () => {
    const s = seed('like-11', [11n], { lastActivityBlock: H - 1 });
    const authorKey = seededIdentity('like-11/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const postId = hex(uid('like-11/post'));
    putConfirmedPost(s.view, postId, authorKey);
    const like = likeTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, postId, authorKey, H);
    expectAccepted(s, [like]);
  });

  it('like at 10 — refused (below the floor)', () => {
    const s = seed('like-10', [10n], { lastActivityBlock: H - 1 });
    const authorKey = seededIdentity('like-10/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const postId = hex(uid('like-10/post'));
    putConfirmedPost(s.view, postId, authorKey);
    const like = likeTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, postId, authorKey, H);
    expectRefusedAt(s, [like], like, FLOOR_RULE);
  });

  // vouch cast at 11 valid, 10 refused (member voucher, fresh, spend 1)
  it('vouch cast at 11 — accepted', () => {
    const s = seed('vouch-11', [11n], { memberSinceBlock: 1, lastActivityBlock: H - 1 });
    const target = seededIdentity('vouch-11/target');
    s.view.putIdentityRecord(target.userId, identityRecord({}));
    const vouch = vouchTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, target.userId, H);
    expectAccepted(s, [vouch]);
  });

  it('vouch cast at 10 — refused (below the floor)', () => {
    const s = seed('vouch-10', [10n], { memberSinceBlock: 1, lastActivityBlock: H - 1 });
    const target = seededIdentity('vouch-10/target');
    s.view.putIdentityRecord(target.userId, identityRecord({}));
    const vouch = vouchTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, target.userId, H);
    expectRefusedAt(s, [vouch], vouch, FLOOR_RULE);
  });

  // invite of bond b: valid at b + 10, refused at b + 9 (spend = b, floor = 10)
  it('invite with bond 25 at face 35 — accepted', () => {
    const s = seed('invite-35', [35n], { memberSinceBlock: 1, lastActivityBlock: H - 1 });
    const invite = inviteTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, seededIdentity('invite-35/invitee').userId, 25n, H);
    expectAccepted(s, [invite]);
  });

  it('invite with bond 25 at face 34 — refused (below the floor)', () => {
    const s = seed('invite-34', [34n], { memberSinceBlock: 1, lastActivityBlock: H - 1 });
    const invite = inviteTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, seededIdentity('invite-34/invitee').userId, 25n, H);
    expectRefusedAt(s, [invite], invite, FLOOR_RULE);
  });

  // name burn at USERNAME_BURN_PRICE + 10 valid, one below refused
  // Need a username box the owner already holds; the burn spends it with a karma input.
  function nameBurn(label: string, karmaValue: bigint): { s: Seed; burn: Built } {
    const s = seed(label, [karmaValue], { lastActivityBlock: H - 1 });
    const name = new TextEncoder().encode(`alice${label.replace(/[^a-z0-9_]/gi, '').toLowerCase()}`);
    const u: AnyBox = seedProvenance<UsernameBox>({ boxType: 'username', value: 0n, createdAtBlock: 0, owner: s.actor.userId, name }, 0, 42);
    s.view.insertBox(u);
    s.view.putUsername({
      nameLower: new TextDecoder().decode(name),
      name: new TextDecoder().decode(name),
      owner: hex(s.actor.userId),
      boxId: u.id!,
      claimedAtBlock: 0,
    });
    const karma = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const burn = burnTx(s.actor, karma, u, H);
    return { s, burn };
  }

  it('name burn at face 20 (USERNAME_BURN_PRICE + 10) — accepted', () => {
    const { s, burn } = nameBurn('burn-20', 20n);
    expectAccepted(s, [burn]);
  });

  it('name burn at face 19 — refused (below the floor)', () => {
    const { s, burn } = nameBurn('burn-19', 19n);
    expectRefusedAt(s, [burn], burn, FLOOR_RULE);
  });

  // thread at 5 valid; at 4 the thread cannot be formed (conservation), but the block is refused.
  it('thread at face 5 — accepted', () => {
    const s = seed('thread-5', [5n], { lastActivityBlock: H - 1 });
    const thread = threadTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'exact', H);
    expectAccepted(s, [thread]);
  });

  it('thread at face 4 — refused (its conservation fails before the spend rule)', () => {
    const s = seed('thread-4', [4n], { lastActivityBlock: H - 1 });
    const thread = threadTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'short', H);
    const before = s.view.digest();
    const block = candidateBlock(s.view, H, [thread], miner.userId, CTX);
    const result = applyBlock(s.view, block, CTX);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(thread.txId) });
    expect(s.view.digest()).toBe(before);
  });

  // reply at 3 valid; at 2 the reply cannot be formed. The parent is a confirmed post.
  it('reply at face 3 — accepted', () => {
    const s = seed('reply-3', [3n], { lastActivityBlock: H - 1 });
    const parent = seededIdentity('reply-3/parent-author');
    s.view.putIdentityRecord(parent.userId, identityRecord({ lastActivityBlock: H - 1 }));
    const parentPostId = hex(uid('reply-3/parent'));
    putConfirmedPost(s.view, parentPostId, parent.userId);
    const reply = replyTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'r', parentPostId, parent.userId, H);
    expectAccepted(s, [reply]);
  });

  it('reply at face 2 — refused (its conservation fails before the spend rule)', () => {
    const s = seed('reply-2', [2n], { lastActivityBlock: H - 1 });
    const parent = seededIdentity('reply-2/parent-author');
    s.view.putIdentityRecord(parent.userId, identityRecord({ lastActivityBlock: H - 1 }));
    const parentPostId = hex(uid('reply-2/parent'));
    putConfirmedPost(s.view, parentPostId, parent.userId);
    const reply = replyTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'r', parentPostId, parent.userId, H);
    const before = s.view.digest();
    const block = candidateBlock(s.view, H, [reply], miner.userId, CTX);
    const result = applyBlock(s.view, block, CTX);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(reply.txId) });
    expect(s.view.digest()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Nothing spent, nothing judged
// ---------------------------------------------------------------------------

describe('a transaction that spends nothing is not judged', () => {
  // Owner holds two 2-karma boxes (face 4, below the floor). A consolidation outputs one
  // 4-karma box: non-karma spend 0, not judged.
  it('a consolidation by an owner holding less than the floor is accepted', () => {
    const s = seed('consolidate-sub-floor', [2n, 2n], { lastActivityBlock: H - 1 });
    const con = consolidateTx(s.actor, s.view.getKarmaBoxes(s.actor.userId), H);
    expectAccepted(s, [con]);
  });

  // A claim: the username output's value is 0, so non-karma spend is 0: not judged.
  it('a claim by an owner holding less than the floor is accepted', () => {
    const s = seed('claim-sub-floor', [4n], { lastActivityBlock: H - 1 });
    const claim = claimTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'lowkarma', H);
    expectAccepted(s, [claim]);
  });

  // A withdrawal: karma → karma same owner, non-karma spend 0, not judged.
  it('a withdrawal by an owner holding less than the floor is accepted', () => {
    const s = seed('withdraw-sub-floor', [4n], { lastActivityBlock: H - 1 });
    // Pre-confirm a post the actor authored.
    const postId = hex(uid('withdraw/post'));
    putConfirmedPost(s.view, postId, s.actor.userId);
    const withdraw = withdrawTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, postId, H);
    expectAccepted(s, [withdraw]);
  });

  // A claim by a stale identity exactly at the floor (one box of 10, effective 10) is accepted.
  it('a claim by a stale identity at the floor is accepted', () => {
    const s = seed('claim-stale-floor', [10n], { lastActivityBlock: 1 });
    const claim = claimTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'floorclaim', H);
    expectAccepted(s, [claim]);
  });

  // A withdrawal by a stale identity exactly at the floor is accepted.
  it('a withdrawal by a stale identity at the floor is accepted', () => {
    const s = seed('withdraw-stale-floor', [10n], { lastActivityBlock: 1 });
    const postId = hex(uid('withdraw-stale-floor/post'));
    putConfirmedPost(s.view, postId, s.actor.userId);
    const withdraw = withdrawTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, postId, H);
    expectAccepted(s, [withdraw]);
  });

  // A consolidation by a stale identity exactly at the floor (face 10, effective 10) is accepted.
  it('a consolidation by a stale identity at the floor is accepted', () => {
    const s = seed('consolidate-stale-floor', [5n, 5n], { lastActivityBlock: 1 });
    const con = consolidateTx(s.actor, s.view.getKarmaBoxes(s.actor.userId), H);
    expectAccepted(s, [con]);
  });
});

// ---------------------------------------------------------------------------
// `owed` is the pre-body reading
// ---------------------------------------------------------------------------

describe('`owed` is read once, from pre-body state', () => {
  // Stale identity, face 21, lastDecayBlock 597 so periods=1 and effective=16, owed_rule=5.
  // Pre-body held=21, remaining=16.
  //  Thread (spend 5): 16 >= 5 ✓, change=16. Activity bumps the clock (overlay).
  //  Like 1 (spend 1): held=16, owed_pre=5 (NOT the overlay record), remaining=11, 11-1=10 >= 10 ✓.
  //  Like 2 (spend 1): held=15, remaining=10, 10-1=9 < 10 → refused.
  // A reader of the overlay record would find the identity fresh after the thread and accept all three.
  it('a stale identity, effective 16 — thread + two likes: the second like refused', () => {
    const s = seed('owed-prebody', [21n], { lastActivityBlock: 1, lastDecayBlock: 597 });
    const authorKey = seededIdentity('owed-prebody/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const [p1, p2] = [hex(uid('owed-prebody/p1')), hex(uid('owed-prebody/p2'))];
    putConfirmedPost(s.view, p1, authorKey);
    putConfirmedPost(s.view, p2, authorKey);
    const thread = threadTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'bump', H);
    const like1 = likeTx(s.actor, changeOf(thread), p1, authorKey, H);
    const like2 = likeTx(s.actor, changeOf(like1), p2, authorKey, H);
    expectRefusedAt(s, [thread, like1, like2], like2, FLOOR_RULE);
  });

  it('a stale identity, effective 16 — thread + one like is accepted', () => {
    const s = seed('owed-prebody-ok', [21n], { lastActivityBlock: 1, lastDecayBlock: 597 });
    const authorKey = seededIdentity('owed-prebody-ok/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const postId = hex(uid('owed-prebody-ok/p'));
    putConfirmedPost(s.view, postId, authorKey);
    const thread = threadTx(s.actor, s.view.getKarmaBoxes(s.actor.userId)[0]!, 'bump', H);
    const like = likeTx(s.actor, changeOf(thread), postId, authorKey, H);
    expectAccepted(s, [thread, like]);
  });
});

// ---------------------------------------------------------------------------
// `held` is the sum across boxes
// ---------------------------------------------------------------------------

describe('`held` is the summed value across karma boxes', () => {
  // Owner holds two karma boxes [1, 10]. A like consumes the 1-karma box. Spend = 1.
  // held = 1 + 10 = 11, owed = 0 (fresh), remaining = 11. 11 - 1 = 10 ≥ 10 → accepted.
  it('a like spends a 1-karma box while a second box holds 10 — accepted', () => {
    const s = seed('held-sum-ok', [1n, 10n], { lastActivityBlock: H - 1 });
    const authorKey = seededIdentity('held-sum-ok/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const postId = hex(uid('held-sum-ok/post'));
    putConfirmedPost(s.view, postId, authorKey);
    // Pick the 1-karma box as the input.
    const smaller = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.value === 1n)!;
    const like = likeTx(s.actor, smaller, postId, authorKey, H);
    expectAccepted(s, [like]);
  });

  // Same shape but the second box holds 9: held = 1 + 9 = 10, 10 - 1 = 9 < 10 → refused.
  it('a like spends a 1-karma box while a second box holds 9 — refused', () => {
    const s = seed('held-sum-fail', [1n, 9n], { lastActivityBlock: H - 1 });
    const authorKey = seededIdentity('held-sum-fail/author').userId;
    s.view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    const postId = hex(uid('held-sum-fail/post'));
    putConfirmedPost(s.view, postId, authorKey);
    const smaller = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.value === 1n)!;
    const like = likeTx(s.actor, smaller, postId, authorKey, H);
    expectRefusedAt(s, [like], like, FLOOR_RULE);
  });
});

// ---------------------------------------------------------------------------
// Two owners interleaved
// ---------------------------------------------------------------------------

describe('two owners in one body are judged apart', () => {
  // A: face 11, remaining 11. A1 (11-1=10) ✓, A2 would be 10-1=9 ✗.
  // B: face 12, remaining 12. B1 (12-1=11) ✓, B2 (11-1=10) ✓, B3 would be 10-1=9 ✗.
  function twoOwners() {
    const view = new MemoryStateView({ memberCount: 1 });
    const A = seededIdentity('two-owners/A');
    const B = seededIdentity('two-owners/B');
    const authorKey = seededIdentity('two-owners/author').userId;
    view.putIdentityRecord(A.userId, identityRecord({ lastActivityBlock: H - 1 }));
    view.putIdentityRecord(B.userId, identityRecord({ lastActivityBlock: H - 1 }));
    view.putIdentityRecord(authorKey, identityRecord({ lastActivityBlock: H - 1 }));
    view.putIdentityRecord(miner.userId, identityRecord({ memberSinceBlock: 1 }));
    let nonce = 1;
    view.insertBox(karmaBox(A.userId, 11n, nonce++, 0));
    view.insertBox(karmaBox(B.userId, 12n, nonce++, 0));
    view.insertBox(protocolBox('emission', PROFILE.creditEmissionTotal, nonce++));
    view.insertBox(protocolBox('karma_pool', 1_000_000n, nonce++));
    const posts = [0, 1, 2].map((i) => {
      const id = hex(uid(`two-owners/post/${i}`));
      putConfirmedPost(view, id, authorKey);
      return id;
    });
    return { view, A, B, authorKey, posts };
  }

  // Interleaved A1, B1, A2 — the block fails at A2 (never reaches B2).
  it('two owners interleaved — one owner\'s second spend crosses the floor, the other\'s does not', () => {
    const { view, A, B, authorKey, posts } = twoOwners();
    const A1 = likeTx(A, view.getKarmaBoxes(A.userId)[0]!, posts[0]!, authorKey, H);
    const B1 = likeTx(B, view.getKarmaBoxes(B.userId)[0]!, posts[1]!, authorKey, H);
    const A2 = likeTx(A, changeOf(A1), posts[2]!, authorKey, H);
    const before = view.digest();
    const block = candidateBlock(view, H, [A1, B1, A2], miner.userId, CTX);
    const result = applyBlock(view, block, CTX);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(A2.txId) });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(FLOOR_RULE) });
    expect(view.digest()).toBe(before);
  });

  // A1, B1, B2 — each owner stays on its own side of the line; both end holding 10.
  it('two owners interleaved — each owner\'s spends stay on their side of the floor, both accepted', () => {
    const { view, A, B, authorKey, posts } = twoOwners();
    const A1 = likeTx(A, view.getKarmaBoxes(A.userId)[0]!, posts[0]!, authorKey, H);
    const B1 = likeTx(B, view.getKarmaBoxes(B.userId)[0]!, posts[1]!, authorKey, H);
    const B2 = likeTx(B, changeOf(B1), posts[2]!, authorKey, H);
    expectAccepted({ view, actor: A }, [A1, B1, B2]);
    expect(karmaFaceOf(view, A.userId)).toBe(10n);
    expect(karmaFaceOf(view, B.userId)).toBe(10n);
  });
});

// ---------------------------------------------------------------------------
// Through `validateTx` over a deps literal
// ---------------------------------------------------------------------------

describe('validateTx answers from `getKarmaValue` and `getKarmaOwed`', () => {
  const actor = seededIdentity('validate/actor');
  const parent = seededIdentity('validate/parent');
  // A pre-existing karma box the actor owns.
  function karma(value: bigint, nonce = 1): KarmaBox {
    return karmaBox(actor.userId, value, nonce, 0);
  }
  // A confirmed parent post with the parent's recorded author.
  const parentPostId = hex(uid('validate/parent-post'));

  // One deps literal: controlled `getKarmaValue` and `getKarmaOwed`, every other dep refused.
  function deps(opts: {
    held: bigint;
    owed: bigint;
    boxes: AnyBox[];
    getKarmaOwed?: (owner: Uint8Array, height: number) => bigint;
  }): UtxoEngineDeps {
    const live = new Map(opts.boxes.map((b) => [b.id!, b]));
    const unread = (name: string) => (..._args: unknown[]): never => {
      throw new Error(`validate case reads no ${name}`);
    };
    const literal: UtxoEngineDeps = {
      getBox: (id: string) => live.get(id) ?? null,
      insertBox: unread('insertBox'),
      consumeBox: unread('consumeBox'),
      getKarmaValue: () => opts.held,
      getKarmaOwed: opts.getKarmaOwed ?? (() => opts.owed),
      getIdentityRecord: unread('getIdentityRecord'),
      hasActiveVouchEscrow: unread('hasActiveVouchEscrow'),
      vouchCooldownBlocks: CTX.vouchCooldownBlocks,
      getTopologyAuthor: (postId: string) => (postId === parentPostId ? parent.userId : null),
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => fn(),
      inviteBondMin: CTX.inviteBondMin,
      inviteBondMax: CTX.inviteBondMax,
      decayCfg: CTX.decayCfg,
      storageRentPeriodBlocks: CTX.storageRentPeriodBlocks,
      getBoxProvenance: (id: string) => {
        const b = live.get(id);
        return b ? { txId: b.txId, index: b.index } : null;
      },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: CTX.membershipBarMultiplier,
      putIdentityRecord: unread('putIdentityRecord'),
      protocolVersionSchedule: CTX.protocolVersionSchedule,
      getUsername: () => null,
      getUsernameByOwner: () => null,
    };
    return literal;
  }

  // A reply: spend = POST_PRICE_REPLY (3n). Post rule — remaining ≥ spend.
  function replyTxFor(input: KarmaBox): Built {
    return finish({
      inputs: [input.id!],
      outputs: [
        { boxType: 'karma_price', value: POST_PRICE_REPLY - 1n, createdAtBlock: H },
        { boxType: 'like_accrual', value: 1n, createdAtBlock: H, author: parent.userId },
      ] as AnyBoxCandidate[],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: {
        contentHash: new Uint8Array(32).fill(0x01),
        author: actor.userId,
        parentRefs: [parentPostId],
        protocolVersion: PROTOCOL_VERSION,
        type: 'regular',
      },
    }, actor);
  }

  // A like: spend = LIKE_KARMA_COST (1n). Non-post — remaining − spend ≥ floor.
  function likeTxFor(input: KarmaBox): Built {
    return finish({
      inputs: [input.id!],
      outputs: [
        { boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: H, author: parent.userId },
      ] as AnyBoxCandidate[],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: parentPostId,
    }, actor);
  }

  it('a reply with held=3 owed=1 (remaining=2, spend=3) is refused', () => {
    const k = karma(POST_PRICE_REPLY); // input value must equal the spend's non-karma outputs
    const reply = replyTxFor(k);
    const result = validateTx(deps({ held: 3n, owed: 1n, boxes: [k] }), reply.tx, H);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(POST_RULE);
  });

  it('a reply with held=3 owed=0 (remaining=3, spend=3) is valid', () => {
    const k = karma(POST_PRICE_REPLY);
    const reply = replyTxFor(k);
    const result = validateTx(deps({ held: 3n, owed: 0n, boxes: [k] }), reply.tx, H);
    expect(result.valid).toBe(true);
  });

  it('a like with held=10 owed=0 (remaining=10, spend=1) is refused — below the floor', () => {
    const k = karma(1n);
    const like = likeTxFor(k);
    const result = validateTx(deps({ held: 10n, owed: 0n, boxes: [k] }), like.tx, H);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(FLOOR_RULE);
  });

  it('a like with held=11 owed=0 (remaining=11, spend=1) is valid', () => {
    const k = karma(1n);
    const like = likeTxFor(k);
    const result = validateTx(deps({ held: 11n, owed: 0n, boxes: [k] }), like.tx, H);
    expect(result.valid).toBe(true);
  });

  it('getKarmaOwed is called with the owner and the height validateTx was given', () => {
    const k = karma(LIKE_KARMA_COST);
    const like = likeTxFor(k);
    const spy = vi.fn((_owner: Uint8Array, _height: number) => 0n);
    const d = deps({ held: 11n, owed: 0n, boxes: [k], getKarmaOwed: spy });
    const result = validateTx(d, like.tx, H);
    expect(result.valid).toBe(true);
    expect(spy).toHaveBeenCalled();
    const [owner, height] = spy.mock.calls[0]!;
    expect(hex(owner)).toBe(hex(actor.userId));
    expect(height).toBe(H);
  });
});

// ---------------------------------------------------------------------------
// The rule is the arm's last word
// ---------------------------------------------------------------------------

describe('the spend rule is the arm\'s last word', () => {
  // A vouch whose createdAtBlock lags the window AND whose voucher is below the floor.
  // The cast window is judged ahead of the spend rule, which is the arm's last check,
  // so the window's reason wins.
  it('a vouch failing the window and the spend rule — the window reason wins', () => {
    const s = seed('arms-last', [5n], { memberSinceBlock: 1, lastActivityBlock: H - 1 });
    const target = seededIdentity('arms-last/target');
    s.view.putIdentityRecord(target.userId, identityRecord({}));
    const karma = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    // Build a vouch with createdAtBlock far behind H, past VOUCH_CAST_HEIGHT_WINDOW.
    const vouch = finish({
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value - VOUCH_KARMA_AMOUNT, createdAtBlock: H, owner: s.actor.userId },
        { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: H - 100, voucherId: s.actor.userId, targetId: target.userId },
      ] as AnyBoxCandidate[],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    const before = s.view.digest();
    const block = candidateBlock(s.view, H, [vouch], miner.userId, CTX);
    const result = applyBlock(s.view, block, CTX);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(vouch.txId) });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('blocks behind height') });
    expect(s.view.digest()).toBe(before);
  });

  // A self-vouch by a voucher at the floor: the self-vouch rule wins over the spend rule.
  it('a self-vouch by a voucher at the floor — the self-vouch reason wins', () => {
    const s = seed('arms-self', [10n], { memberSinceBlock: 1, lastActivityBlock: H - 1 });
    const karma = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const selfVouch = finish({
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value - VOUCH_KARMA_AMOUNT, createdAtBlock: H, owner: s.actor.userId },
        { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: H, voucherId: s.actor.userId, targetId: s.actor.userId },
      ] as AnyBoxCandidate[],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    const before = s.view.digest();
    const block = candidateBlock(s.view, H, [selfVouch], miner.userId, CTX);
    const result = applyBlock(s.view, block, CTX);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(selfVouch.txId) });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('Cannot vouch for yourself') });
    expect(s.view.digest()).toBe(before);
  });
});
