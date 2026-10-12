import { describe, it, expect } from 'vitest';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  LIKE_KARMA_COST,
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  PROTOCOL_VERSION,
  REPLY_AUTHOR_SHARE,
  USERNAME_BURN_PRICE,
  VOUCH_KARMA_AMOUNT,
  profileFor,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, KarmaBox, UsernameBox } from '@dagsocial/types';
import { applyBlock, validateTx } from '@dagsocial/consensus';
import type { ApplyContext, UtxoEngineDeps } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  candidateBlock,
  changeOf,
  consolidateTx,
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
  type TestIdentity,
} from './helpers.js';

// NODE_INTERFACE → Karma transition rules → "An identity holds at most two
// karma boxes". Three rules of the karma arm hold a user transaction to it, on
// every row of the transition table:
//   1. at most one karma output
//   2. no karma output carries `income`
//   3. every id deps.getOwnKarmaBoxIds(owner) answers is among the inputs

const PROFILE = profileFor('devnet');
const CTX: ApplyContext = {
  ...applyContextFor(PROFILE),
  decayCfg: { staleThresholdBlocks: 6, decayIntervalBlocks: 3, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM },
};
const H = 600;
const miner = seededIdentity('karma-spend-shape/miner');

interface Seed {
  view: MemoryStateView;
  actor: TestIdentity;
}

function seedView(label: string, seedBoxes: (actorId: Uint8Array) => KarmaBox[], recFields: Parameters<typeof identityRecord>[0] = { lastActivityBlock: H - 1 }): Seed {
  const view = new MemoryStateView({ memberCount: 1 });
  const actor = seededIdentity(`karma-spend-shape/${label}/actor`);
  view.putIdentityRecord(actor.userId, identityRecord(recFields));
  view.putIdentityRecord(miner.userId, identityRecord({ memberSinceBlock: 1 }));
  let nonce = 1;
  for (const box of seedBoxes(actor.userId)) view.insertBox(box);
  view.insertBox(protocolBox('emission', PROFILE.creditEmissionTotal, 100 + nonce++));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, 100 + nonce++));
  return { view, actor };
}

function putConfirmedPost(view: MemoryStateView, postId: string, author: Uint8Array): void {
  view.insertPost(postId);
  view.insertBlockTopology(postId, author, H - 1);
}

function expectAccepted(view: MemoryStateView, txs: Built[]): void {
  const block = candidateBlock(view, H, txs, miner.userId, CTX);
  const result = applyBlock(view, block, CTX);
  if (!result.ok) throw new Error(`block refused: ${result.reason}`);
  writeEffects(view, result.effects, H);
}

function expectRefused(view: MemoryStateView, txs: Built[], tx: Built, phrase?: string): void {
  const before = view.digest();
  const block = candidateBlock(view, H, txs, miner.userId, CTX);
  const result = applyBlock(view, block, CTX);
  expect(result).toEqual({ ok: false, reason: expect.stringContaining(tx.txId) });
  if (phrase !== undefined) expect(result).toEqual({ ok: false, reason: expect.stringContaining(phrase) });
  expect(view.digest()).toBe(before);
}

const karmaOut = (owner: Uint8Array, value: bigint, h: number, income?: true): AnyBoxCandidate =>
  (income === true
    ? { boxType: 'karma', value, createdAtBlock: h, owner, income: true }
    : { boxType: 'karma', value, createdAtBlock: h, owner }) as AnyBoxCandidate;

// ---------------------------------------------------------------------------
// Rule 1 — at most one karma output
// ---------------------------------------------------------------------------

describe('rule 1 — at most one karma output on every karma arm', () => {
  it('the plain karma -> karma shape refuses two karma outputs', () => {
    const s = seedView('r1/plain', (id) => [karmaBox(id, 20n, 1, 0)]);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [karmaOut(s.actor.userId, 10n, H), karmaOut(s.actor.userId, 10n, H)],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('the invite refuses two karma outputs', () => {
    const s = seedView('r1/invite', (id) => [karmaBox(id, 50n, 1, 0)], { memberSinceBlock: 1, lastActivityBlock: H - 1 });
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const invitee = seededIdentity('r1/invite/invitee');
    const tx = finish({
      inputs: [input.id!],
      outputs: [
        karmaOut(s.actor.userId, 20n, H),
        karmaOut(s.actor.userId, 25n, H),
        { boxType: 'bond', value: 5n, createdAtBlock: H, inviterId: s.actor.userId, inviteePublicKey: invitee.userId } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('the vouch cast refuses two karma outputs', () => {
    const s = seedView('r1/vouch', (id) => [karmaBox(id, 20n, 1, 0)], { memberSinceBlock: 1, memberVouches: 10, memberBar: 1, lastActivityBlock: H - 1 });
    const target = seededIdentity('r1/vouch/target');
    s.view.putIdentityRecord(target.userId, identityRecord({}));
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [
        karmaOut(s.actor.userId, 10n, H),
        karmaOut(s.actor.userId, 9n, H),
        { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: H, voucherId: s.actor.userId, targetId: target.userId } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('the like refuses two karma outputs', () => {
    const s = seedView('r1/like', (id) => [karmaBox(id, 20n, 1, 0)]);
    const author = seededIdentity('r1/like/author');
    const postId = hex(uid('r1/like/post'));
    putConfirmedPost(s.view, postId, author.userId);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [
        karmaOut(s.actor.userId, 10n, H),
        karmaOut(s.actor.userId, 9n, H),
        { boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: H, author: author.userId } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('the thread refuses two karma outputs', () => {
    const s = seedView('r1/thread', (id) => [karmaBox(id, 20n, 1, 0)]);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [
        karmaOut(s.actor.userId, 8n, H),
        karmaOut(s.actor.userId, 7n, H),
        { boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: H } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: { contentHash: new Uint8Array(32).fill(0x01), author: s.actor.userId, parentRefs: [], protocolVersion: PROTOCOL_VERSION, type: 'regular' },
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('the reply refuses two karma outputs', () => {
    const s = seedView('r1/reply', (id) => [karmaBox(id, 20n, 1, 0)]);
    const parentAuthor = seededIdentity('r1/reply/parent-author');
    const parentPostId = hex(uid('r1/reply/parent'));
    putConfirmedPost(s.view, parentPostId, parentAuthor.userId);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [
        karmaOut(s.actor.userId, 10n, H),
        karmaOut(s.actor.userId, 7n, H),
        { boxType: 'karma_price', value: POST_PRICE_REPLY - REPLY_AUTHOR_SHARE, createdAtBlock: H } as AnyBoxCandidate,
        { boxType: 'like_accrual', value: REPLY_AUTHOR_SHARE, createdAtBlock: H, author: parentAuthor.userId } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: { contentHash: new Uint8Array(32).fill(0x02), author: s.actor.userId, parentRefs: [parentPostId], protocolVersion: PROTOCOL_VERSION, type: 'regular' },
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('the claim refuses two karma outputs', () => {
    const s = seedView('r1/claim', (id) => [karmaBox(id, 20n, 1, 0)]);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [
        karmaOut(s.actor.userId, 10n, H),
        karmaOut(s.actor.userId, 10n, H),
        { boxType: 'username', value: 0n, createdAtBlock: H, owner: s.actor.userId, name: new TextEncoder().encode('alice') } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('the burn refuses two karma outputs', () => {
    const s = seedView('r1/burn', (id) => [karmaBox(id, 50n, 1, 0)]);
    const name = seedProvenance<UsernameBox>({ boxType: 'username', value: 0n, createdAtBlock: 0, owner: s.actor.userId, name: new TextEncoder().encode('bob') }, 0, 42);
    s.view.insertBox(name);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!, name.id!],
      outputs: [
        karmaOut(s.actor.userId, 20n, H),
        karmaOut(s.actor.userId, 20n, H),
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: H } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('a withdrawal with zero karma outputs is refused', () => {
    const s = seedView('r1/withdraw-zero', (id) => [karmaBox(id, 10n, 1, 0)]);
    const postId = hex(uid('r1/withdraw-zero/post'));
    putConfirmedPost(s.view, postId, s.actor.userId);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [{ boxType: 'karma_price', value: 10n, createdAtBlock: H } as AnyBoxCandidate],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId },
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('a withdrawal with two karma outputs is refused', () => {
    const s = seedView('r1/withdraw-two', (id) => [karmaBox(id, 20n, 1, 0)]);
    const postId = hex(uid('r1/withdraw-two/post'));
    putConfirmedPost(s.view, postId, s.actor.userId);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [karmaOut(s.actor.userId, 10n, H), karmaOut(s.actor.userId, 10n, H)],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId },
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — no karma output carries `income`
// ---------------------------------------------------------------------------

describe('rule 2 — a user transaction never writes the income mark', () => {
  it('the plain karma -> karma shape refuses an income-marked karma output', () => {
    const s = seedView('r2/plain', (id) => [karmaBox(id, 20n, 1, 0)]);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [karmaOut(s.actor.userId, 20n, H, true)],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('the thread refuses an income-marked karma change', () => {
    const s = seedView('r2/thread', (id) => [karmaBox(id, 20n, 1, 0)]);
    const input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = finish({
      inputs: [input.id!],
      outputs: [
        karmaOut(s.actor.userId, 15n, H, true),
        { boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: H } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: { contentHash: new Uint8Array(32).fill(0x03), author: s.actor.userId, parentRefs: [], protocolVersion: PROTOCOL_VERSION, type: 'regular' },
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — every id getOwnKarmaBoxIds answers is among the inputs
// ---------------------------------------------------------------------------

describe('rule 3 — the own box is named', () => {
  it('M + P held: a spend naming P alone is refused', () => {
    const s = seedView('r3/P-alone', (id) => [karmaBox(id, 3n, 1, 0), incomeBox(id, 5n, 2, 0)]);
    const P = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.income === true)!;
    const tx = consolidateTx(s.actor, [P], H);
    expectRefused(s.view, [tx], tx);
  });

  it('M + P held: a spend naming M alone is admitted and leaves P untouched', () => {
    const s = seedView('r3/M-alone', (id) => [karmaBox(id, 3n, 1, 0), incomeBox(id, 5n, 2, 0)]);
    const M = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.income !== true)!;
    const P = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.income === true)!;
    const tx = consolidateTx(s.actor, [M], H);
    expectAccepted(s.view, [tx]);
    expect(s.view.getBox(P.id!)).toEqual(P);
  });

  it('M + P held: a spend naming both is admitted and makes one unmarked output of their sum less the spend', () => {
    const s = seedView('r3/both', (id) => [karmaBox(id, 3n, 1, 0), incomeBox(id, 5n, 2, 0)]);
    const boxes = s.view.getKarmaBoxes(s.actor.userId);
    const tx = consolidateTx(s.actor, boxes, H);
    expectAccepted(s.view, [tx]);
    const remaining = s.view.getKarmaBoxes(s.actor.userId).filter((b) => b.income !== true);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.value).toBe(8n);
    expect(s.view.getKarmaBoxes(s.actor.userId).filter((b) => b.income === true)).toHaveLength(0);
  });

  it('P alone held: the owner spends P and the change is unmarked', () => {
    const s = seedView('r3/P-only', (id) => [incomeBox(id, 20n, 1, 0)]);
    const P = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const tx = consolidateTx(s.actor, [P], H);
    expectAccepted(s.view, [tx]);
    const after = s.view.getKarmaBoxes(s.actor.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.income).toBeUndefined();
    expect(after[0]!.value).toBe(20n);
  });

  it('nothing left: a thread of M + P whose cost is their whole sum emits no karma output', () => {
    const s = seedView('r3/nothing-left', (id) => [karmaBox(id, 2n, 1, 0), incomeBox(id, 3n, 2, 0)]);
    const boxes = s.view.getKarmaBoxes(s.actor.userId);
    const tx = finish({
      inputs: boxes.map((b) => b.id!),
      outputs: [{ boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: H } as AnyBoxCandidate],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: { contentHash: new Uint8Array(32).fill(0x04), author: s.actor.userId, parentRefs: [], protocolVersion: PROTOCOL_VERSION, type: 'regular' },
    }, s.actor);
    expectAccepted(s.view, [tx]);
    expect(s.view.getKarmaBoxes(s.actor.userId)).toHaveLength(0);
  });

  it('the floor counts both boxes: own 5 + income 20, a like naming the own box alone is admitted', () => {
    const s = seedView('r3/floor-pass', (id) => [karmaBox(id, 5n, 1, 0), incomeBox(id, 20n, 2, 0)]);
    const M = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.income !== true)!;
    const author = seededIdentity('r3/floor-pass/author');
    s.view.putIdentityRecord(author.userId, identityRecord({ lastActivityBlock: H - 1 }));
    const postId = hex(uid('r3/floor-pass/post'));
    putConfirmedPost(s.view, postId, author.userId);
    const tx = likeTx(s.actor, M, postId, author.userId, H);
    expectAccepted(s.view, [tx]);
  });

  it('the floor counts both boxes: own 5 + income 4, the same like is refused for the floor', () => {
    const s = seedView('r3/floor-fail', (id) => [karmaBox(id, 5n, 1, 0), incomeBox(id, 4n, 2, 0)]);
    const M = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.income !== true)!;
    const author = seededIdentity('r3/floor-fail/author');
    s.view.putIdentityRecord(author.userId, identityRecord({ lastActivityBlock: H - 1 }));
    const postId = hex(uid('r3/floor-fail/post'));
    putConfirmedPost(s.view, postId, author.userId);
    const tx = likeTx(s.actor, M, postId, author.userId, H);
    expectRefused(s.view, [tx], tx, 'below the floor');
  });

  it('a name burn beside an income box: naming M and the name box is admitted', () => {
    const s = seedView('r3/burn-M', (id) => [karmaBox(id, 20n, 1, 0), incomeBox(id, 5n, 2, 0)]);
    const M = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.income !== true)!;
    const name = seedProvenance<UsernameBox>({ boxType: 'username', value: 0n, createdAtBlock: 0, owner: s.actor.userId, name: new TextEncoder().encode('zoe') }, 0, 77);
    s.view.insertBox(name);
    s.view.putUsername({ nameLower: 'zoe', name: 'zoe', owner: hex(s.actor.userId), boxId: name.id!, claimedAtBlock: 0 });
    const tx = finish({
      inputs: [M.id!, name.id!],
      outputs: [
        karmaOut(s.actor.userId, M.value - USERNAME_BURN_PRICE, H),
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: H } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    expectAccepted(s.view, [tx]);
  });

  it('a name burn beside an income box: naming P and the name box while M stands is refused', () => {
    const s = seedView('r3/burn-P', (id) => [karmaBox(id, 20n, 1, 0), incomeBox(id, 20n, 2, 0)]);
    const P = s.view.getKarmaBoxes(s.actor.userId).find((b) => b.income === true)!;
    const name = seedProvenance<UsernameBox>({ boxType: 'username', value: 0n, createdAtBlock: 0, owner: s.actor.userId, name: new TextEncoder().encode('zoe') }, 0, 78);
    s.view.insertBox(name);
    s.view.putUsername({ nameLower: 'zoe', name: 'zoe', owner: hex(s.actor.userId), boxId: name.id!, claimedAtBlock: 0 });
    const tx = finish({
      inputs: [P.id!, name.id!],
      outputs: [
        karmaOut(s.actor.userId, P.value - USERNAME_BURN_PRICE, H),
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: H } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, s.actor);
    expectRefused(s.view, [tx], tx);
  });

  it('a chain in one body: first names M+P, second takes the first\'s change; the owner ends with one unmarked box', () => {
    const s = seedView('r3/chain', (id) => [karmaBox(id, 3n, 1, 0), incomeBox(id, 5n, 2, 0)]);
    const boxes = s.view.getKarmaBoxes(s.actor.userId);
    const first = consolidateTx(s.actor, boxes, H);
    const second = consolidateTx(s.actor, [changeOf(first)], H);
    expectAccepted(s.view, [first, second]);
    const after = s.view.getKarmaBoxes(s.actor.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.income).toBeUndefined();
    expect(after[0]!.value).toBe(8n);
  });

  // The wiring assertion: the overlay answers getOwnKarmaBoxIds, so the
  // second spend reads the change the first made rather than the pre-body M.
  it('the own box moves within a body: the first names M; a second naming P alone is refused', () => {
    const s = seedView('r3/move/P-after', (id) => [karmaBox(id, 3n, 1, 0), incomeBox(id, 5n, 2, 0)]);
    const boxes = s.view.getKarmaBoxes(s.actor.userId);
    const M = boxes.find((b) => b.income !== true)!;
    const P = boxes.find((b) => b.income === true)!;
    const first = consolidateTx(s.actor, [M], H);
    const second = consolidateTx(s.actor, [P], H);
    expectRefused(s.view, [first, second], second);
  });

  it('the own box moves within a body: naming the first\'s change and P in the second is admitted', () => {
    const s = seedView('r3/move/both-after', (id) => [karmaBox(id, 3n, 1, 0), incomeBox(id, 5n, 2, 0)]);
    const boxes = s.view.getKarmaBoxes(s.actor.userId);
    const M = boxes.find((b) => b.income !== true)!;
    const P = boxes.find((b) => b.income === true)!;
    const first = consolidateTx(s.actor, [M], H);
    const second = consolidateTx(s.actor, [changeOf(first), P], H);
    expectAccepted(s.view, [first, second]);
    const after = s.view.getKarmaBoxes(s.actor.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.income).toBeUndefined();
    expect(after[0]!.value).toBe(8n);
  });

  it('no own box, in a block: an owner holding P alone makes two spends, the second naming the first\'s change', () => {
    const s = seedView('r3/no-own-chain', (id) => [incomeBox(id, 10n, 1, 0)]);
    const P = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    const first = consolidateTx(s.actor, [P], H);
    const second = consolidateTx(s.actor, [changeOf(first)], H);
    expectAccepted(s.view, [first, second]);
    const after = s.view.getKarmaBoxes(s.actor.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.income).toBeUndefined();
  });

  it('a settlement is not judged by rules 1-3: a block whose settlement pays two owners applies', () => {
    const s = seedView('r3/settlement', (id) => [karmaBox(id, 100n, 1, 0)]);
    const authorA = seededIdentity('r3/settlement/A');
    const authorB = seededIdentity('r3/settlement/B');
    s.view.putIdentityRecord(authorA.userId, identityRecord({ lastActivityBlock: H - 1 }));
    s.view.putIdentityRecord(authorB.userId, identityRecord({ lastActivityBlock: H - 1 }));
    const posts: Array<{ id: string; author: Uint8Array }> = [];
    for (let i = 0; i < 5; i++) {
      const idA = hex(uid(`r3/settlement/postA/${i}`));
      const idB = hex(uid(`r3/settlement/postB/${i}`));
      putConfirmedPost(s.view, idA, authorA.userId);
      putConfirmedPost(s.view, idB, authorB.userId);
      posts.push({ id: idA, author: authorA.userId });
      posts.push({ id: idB, author: authorB.userId });
    }
    const txs: Built[] = [];
    let input = s.view.getKarmaBoxes(s.actor.userId)[0]!;
    for (const p of posts) {
      const tx = likeTx(s.actor, input, p.id, p.author, H);
      txs.push(tx);
      input = changeOf(tx);
    }
    expectAccepted(s.view, txs);
    // The settlement's income leg paid both authors a karma box, each one unmarked
    // on this branch (the mark is a later dispatch's write — the rules on this
    // commit never read a settlement output).
    expect(s.view.getKarmaBoxes(authorA.userId).reduce((sum, b) => sum + b.value, 0n)).toBeGreaterThan(0n);
    expect(s.view.getKarmaBoxes(authorB.userId).reduce((sum, b) => sum + b.value, 0n)).toBeGreaterThan(0n);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — validateTx reads getOwnKarmaBoxIds, every id answered must be among the inputs
// ---------------------------------------------------------------------------

describe('rule 3 — validateTx reads the reader on every answered id', () => {
  const actor = seededIdentity('r3/validate/actor');
  const makeBox = (value: bigint, nonce: number): KarmaBox =>
    karmaBox(actor.userId, value, nonce, 0);

  function stubDeps(opts: { boxes: KarmaBox[]; ownIds: string[] }): UtxoEngineDeps {
    const live = new Map(opts.boxes.map((b) => [b.id!, b as AnyBox]));
    const unread = (name: string) => (..._args: unknown[]): never => {
      throw new Error(`validate case reads no ${name}`);
    };
    const deps = {
      getBox: (id: string) => live.get(id) ?? null,
      insertBox: unread('insertBox'),
      consumeBox: unread('consumeBox'),
      getKarmaValue: () => opts.boxes.reduce((sum, b) => sum + b.value, 0n),
      getKarmaOwed: () => 0n,
      getOwnKarmaBoxIds: () => opts.ownIds.slice(),
      getIdentityRecord: unread('getIdentityRecord'),
      hasActiveVouchEscrow: unread('hasActiveVouchEscrow'),
      vouchCooldownBlocks: CTX.vouchCooldownBlocks,
      getTopologyAuthor: () => null,
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
    } as UtxoEngineDeps;
    return deps;
  }

  it('two own ids answered — a transaction naming only one is refused', () => {
    const [b1, b2] = [makeBox(5n, 1), makeBox(7n, 2)];
    const consol = consolidateTx(actor, [b1], H);
    const deps = stubDeps({ boxes: [b1, b2], ownIds: [b1.id!, b2.id!] });
    const result = validateTx(deps, consol.tx, H);
    expect(result.valid).toBe(false);
  });

  it('two own ids answered — a transaction naming both is admitted', () => {
    const [b1, b2] = [makeBox(5n, 1), makeBox(7n, 2)];
    const consol = consolidateTx(actor, [b1, b2], H);
    const deps = stubDeps({ boxes: [b1, b2], ownIds: [b1.id!, b2.id!] });
    const result = validateTx(deps, consol.tx, H);
    expect(result.valid).toBe(true);
  });
});
