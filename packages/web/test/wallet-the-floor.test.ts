// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  submitPostFlow, submitLikeFlow, submitVouchFlow, submitInviteFlow, submitWithdrawFlow, submitClaimFlow, submitBurnFlow, type SubmitDeps,
} from '../src/wallet/submit';
import { PendingLedger } from '../src/wallet/ledger';
import { KARMA_MINIMUM, LIKE_KARMA_COST, POST_PRICE_THREAD, USERNAME_BURN_PRICE, VOUCH_MIN_BALANCE } from '@dagsocial/types';
import type { Api } from '../src/api/client';
import type { KarmaBoxRow, KarmaResult, PostResult, StatusResult, UsernameResult, VouchesVoucherResult } from '../src/api/dto';
import { karmaResult as karmaFixture } from './karma-fixture';
import type { PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult, WithdrawSubmitResult, ClaimSubmitResult, BurnSubmitResult, SendSubmitResult } from '../src/api/write';

// WEB_INTERFACE → The wallet → "The floor is the client's to know": each
// judged flow holds its spend to the rule against the `effective` of its own
// read, before it builds. A like, a vouch, an invite or a burn the rule
// refuses ends as a refused signature does — nothing signed, nothing sent,
// as the contract's "ends as a refused signature does" names. A post the
// rule refuses is a client refusal — the composer's rejection sentence. A
// withdrawal and a claim spend and return one box, and the node judges no
// spend of 0.

const PUB = 'aa'.repeat(32);
const PARENT_AUTHOR = 'bb'.repeat(32);
const SIG = 'cc'.repeat(64);
const BOX_ID = '11'.repeat(32);
const PARENT_ID = 'dd'.repeat(32);
const TARGET_ID = 'ee'.repeat(32);
const VOUCH_TARGET = '22'.repeat(32);
const INVITEE = '33'.repeat(32);
const USERNAME_BOX = '77'.repeat(32);

let signCalls: string[];
let postReads: Array<{ id: string; viewer?: string }>;
let writeCalls: Array<{ kind: string; tx: Record<string, unknown>; content?: string; targetHex?: string; postId?: string; name?: string }>;

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

// A karma answer with an explicit `effective` beside its boxes — the rule is
// judged against `effective`, so the face of the boxes is sized so the
// builder's own selection passes and the view's own answer carries the floor
// on its own.
function karmaView(boxes: KarmaBoxRow[], effective: bigint): KarmaResult {
  const total = boxes.reduce((sum, b) => sum + BigInt(b.value), 0n);
  return karmaFixture({
    userId: PUB,
    total: total.toString(),
    effective: effective.toString(),
    boxes,
    boxCount: boxes.length,
    height: 6000,
  });
}

function postResult(id: string, confirmedAuthor: string | null): PostResult {
  return {
    id, content: 'parent', contentHash: '00'.repeat(32), author: 'ff'.repeat(32), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5900, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32), confirmedAuthor,
  };
}

let heldName: UsernameResult | null = null;

function reads(
  karma: KarmaResult,
  confirmedAuthor: string | null = PARENT_AUTHOR,
  vouches: VouchesVoucherResult['vouches'] = [],
): Pick<Api, 'karma' | 'credits' | 'status' | 'post' | 'vouchesByVoucher' | 'usernameByOwner'> {
  return {
    karma: async () => karma,
    credits: async () => ({ userId: PUB, total: '0', boxes: [], boxCount: 0, next: null }),
    status: async () => statusResult(),
    post: async (id, viewer) => {
      postReads.push({ id, viewer });
      return postResult(id, confirmedAuthor);
    },
    vouchesByVoucher: async () => ({ vouches, count: vouches.length, next: null }),
    usernameByOwner: async () => heldName,
  };
}

const identity = {
  current: () => ({ pubKeyHex: PUB }),
  sign: async (_bytes: Uint8Array, txId: string) => {
    signCalls.push(txId);
    return { signature: SIG } as const;
  },
};

const lastSignedTxId = (): string => signCalls[signCalls.length - 1]!;

const okPost: PostSubmitResult = { postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: 'ignored' };
const okLike: LikeSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okVouch: VouchSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okInvite: InviteSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720, bondBoxId: 'bond1' };
const okWithdraw: WithdrawSubmitResult = { status: 'submitted', txId: 'ignored', postId: 'ignored', expiresAtHeight: 6720 };
const okClaim: ClaimSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720, name: 'Alice' };
const okBurn: BurnSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okSend: SendSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };

function write(): SubmitDeps['write'] {
  return {
    submitPost: async (tx, content) => {
      writeCalls.push({ kind: 'post', tx, content });
      return { ...okPost, txId: lastSignedTxId() };
    },
    submitLike: async (tx) => {
      writeCalls.push({ kind: 'like', tx });
      return { ...okLike, txId: lastSignedTxId() };
    },
    submitVouch: async (tx) => {
      writeCalls.push({ kind: 'vouch', tx });
      return { ...okVouch, txId: lastSignedTxId() };
    },
    submitUnvouch: async (targetHex, tx) => {
      writeCalls.push({ kind: 'unvouch', tx, targetHex });
      return { ...okVouch, txId: lastSignedTxId() };
    },
    submitInvite: async (tx) => {
      writeCalls.push({ kind: 'invite', tx });
      return { ...okInvite, txId: lastSignedTxId() };
    },
    submitWithdraw: async (postId, tx) => {
      writeCalls.push({ kind: 'withdraw', tx, postId });
      return { ...okWithdraw, txId: lastSignedTxId() };
    },
    submitClaim: async (tx) => {
      writeCalls.push({ kind: 'claim', tx });
      return { ...okClaim, txId: lastSignedTxId() };
    },
    submitBurn: async (name, tx) => {
      writeCalls.push({ kind: 'burn', tx, name });
      return { ...okBurn, txId: lastSignedTxId() };
    },
    submitSend: async (tx) => {
      writeCalls.push({ kind: 'send', tx });
      return { ...okSend, txId: lastSignedTxId() };
    },
  };
}

function depsOf(
  karma: KarmaResult,
  confirmedAuthor: string | null = PARENT_AUTHOR,
  vouches: VouchesVoucherResult['vouches'] = [],
): SubmitDeps {
  return {
    reads: reads(karma, confirmedAuthor, vouches),
    write: write(),
    ledger: new PendingLedger(PUB),
    identity,
    network: null,
  };
}

const BIG_BOX: KarmaBoxRow[] = [{ boxId: BOX_ID, value: '1000' }];

beforeEach(() => {
  signCalls = [];
  postReads = [];
  writeCalls = [];
  heldName = null;
  localStorage.clear();
});

// WEB_INTERFACE → The wallet → "The floor is the client's to know" — each
// judged flow holds its spend to the rule against its own read's `effective`.
describe('a judged flow holds its spend to the floor before it signs', () => {
  // Like: effective − LIKE_KARMA_COST ≥ KARMA_MINIMUM. The pair sits on this
  // rule — one rep either side of it, so a case fails on an off-by-KARMA_MINIMUM gate.
  // A `notSigned: 'refused'` answer with the floor sentence implies the flow
  // signed nothing and POSTed nothing — the result's shape is the whole claim.
  it('like at effective = KARMA_MINIMUM: refused with the floor sentence, nothing signed, nothing POSTed', async () => {
    const deps = depsOf(karmaView(BIG_BOX, KARMA_MINIMUM));
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect({ res, signs: signCalls.length, writes: writeCalls.length })
      .toEqual({ res: { ok: false, notSigned: 'refused', reason: `the last ${KARMA_MINIMUM} rep is for posting` }, signs: 0, writes: 0 });
  });

  it('like at effective = KARMA_MINIMUM + LIKE_KARMA_COST is admitted', async () => {
    const deps = depsOf(karmaView(BIG_BOX, KARMA_MINIMUM + LIKE_KARMA_COST));
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect({ ok: res.ok, writes: writeCalls.map((c) => c.kind) }).toEqual({ ok: true, writes: ['like'] });
  });

  // Vouch: effective ≥ VOUCH_MIN_BALANCE. The pair sits either side.
  it('vouch at effective = VOUCH_MIN_BALANCE − 1: refused with the floor sentence, nothing signed, nothing POSTed', async () => {
    const deps = depsOf(karmaView(BIG_BOX, VOUCH_MIN_BALANCE - 1n));
    const res = await submitVouchFlow(deps, VOUCH_TARGET);
    expect({ res, signs: signCalls.length, writes: writeCalls.length })
      .toEqual({ res: { ok: false, notSigned: 'refused', reason: `the last ${KARMA_MINIMUM} rep is for posting` }, signs: 0, writes: 0 });
  });

  it('vouch at effective = VOUCH_MIN_BALANCE is admitted', async () => {
    const deps = depsOf(karmaView(BIG_BOX, VOUCH_MIN_BALANCE));
    const res = await submitVouchFlow(deps, VOUCH_TARGET);
    expect({ ok: res.ok, writes: writeCalls.map((c) => c.kind) }).toEqual({ ok: true, writes: ['vouch'] });
  });

  // Invite: effective − bond ≥ KARMA_MINIMUM. The pair sits around a stated
  // bond — one rep either side of `effective = bond + KARMA_MINIMUM`.
  it('invite at effective = bond + KARMA_MINIMUM − 1: refused with the floor sentence, nothing signed, nothing POSTed', async () => {
    const bond = 5n;
    const deps = depsOf(karmaView(BIG_BOX, bond + KARMA_MINIMUM - 1n));
    const res = await submitInviteFlow(deps, INVITEE, bond);
    expect({ res, signs: signCalls.length, writes: writeCalls.length })
      .toEqual({ res: { ok: false, notSigned: 'refused', reason: `the last ${KARMA_MINIMUM} rep is for posting` }, signs: 0, writes: 0 });
  });

  it('invite at effective = bond + KARMA_MINIMUM is admitted', async () => {
    const bond = 5n;
    const deps = depsOf(karmaView(BIG_BOX, bond + KARMA_MINIMUM));
    const res = await submitInviteFlow(deps, INVITEE, bond);
    expect({ ok: res.ok, writes: writeCalls.map((c) => c.kind) }).toEqual({ ok: true, writes: ['invite'] });
  });

  // Burn: effective − USERNAME_BURN_PRICE ≥ KARMA_MINIMUM. The reader holds a
  // name, so the burn flow's `usernameByOwner` answers it.
  it('burn at effective = USERNAME_BURN_PRICE + KARMA_MINIMUM − 1: refused with the floor sentence, nothing signed, nothing POSTed', async () => {
    heldName = { name: 'Alice', boxId: USERNAME_BOX, owner: PUB, claimedAtBlock: 5000 };
    const deps = depsOf(karmaView(BIG_BOX, USERNAME_BURN_PRICE + KARMA_MINIMUM - 1n));
    const res = await submitBurnFlow(deps);
    expect({ res, signs: signCalls.length, writes: writeCalls.length })
      .toEqual({ res: { ok: false, notSigned: 'refused', reason: `the last ${KARMA_MINIMUM} rep is for posting` }, signs: 0, writes: 0 });
  });

  it('burn at effective = USERNAME_BURN_PRICE + KARMA_MINIMUM is admitted', async () => {
    heldName = { name: 'Alice', boxId: USERNAME_BOX, owner: PUB, claimedAtBlock: 5000 };
    const deps = depsOf(karmaView(BIG_BOX, USERNAME_BURN_PRICE + KARMA_MINIMUM));
    const res = await submitBurnFlow(deps);
    expect({ ok: res.ok, writes: writeCalls.map((c) => c.kind) }).toEqual({ ok: true, writes: ['burn'] });
  });

  // Post: effective ≥ POST_PRICE_THREAD. The face covers the price, the
  // view's `effective` does not — the client refusal, as the composer makes
  // one; the face/effective split is the point.
  it('post at effective below the price while the face covers it: client refusal, nothing POSTed', async () => {
    const faceAboveThreadPrice: KarmaBoxRow[] = [{ boxId: BOX_ID, value: '1000' }];
    const deps = depsOf(karmaView(faceAboveThreadPrice, POST_PRICE_THREAD - 1n));
    const res = await submitPostFlow(deps, 'a thread', null);
    expect({ res, signs: signCalls.length, writes: writeCalls.length })
      .toEqual({ res: { ok: false, rejection: { status: 0, message: 'not enough rep to post right now.' } }, signs: 0, writes: 0 });
  });

  // The withdrawal and the claim spend and return one box, and the node
  // judges no spend of 0 — the flow builds and POSTs at effective 0 so long
  // as a box is there to spend.
  it('withdrawal at effective = 0 with one rep box: builds, signs and POSTs', async () => {
    const deps = depsOf(karmaView(BIG_BOX, 0n));
    const res = await submitWithdrawFlow(deps, PARENT_ID);
    expect(res.ok).toBe(true);
    expect(writeCalls.map((c) => c.kind)).toEqual(['withdraw']);
  });

  it('claim at effective = 0 with one rep box: builds, signs and POSTs', async () => {
    const deps = depsOf(karmaView(BIG_BOX, 0n));
    const res = await submitClaimFlow(deps, 'Alice');
    expect(res.ok).toBe(true);
    expect(writeCalls.map((c) => c.kind)).toEqual(['claim']);
  });
});
