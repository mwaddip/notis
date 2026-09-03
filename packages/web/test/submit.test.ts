// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { submitPostFlow, submitLikeFlow, type SubmitDeps } from '../src/wallet/submit';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { KarmaBoxRow, KarmaResult, PostResult, StatusResult } from '../src/api/dto';
import type { PostSubmitResult, LikeSubmitResult, Rejection } from '../src/api/write';

// submit ties the reads, the builders, the ledger, the identity and the write
// client into one path. These drive it over fakes and watch what it does: the
// order of reads, the signature over the built id, the entry it lands in the
// ledger, and a rejection short-circuiting before any of that.

const PUB = 'aa'.repeat(32);
const PARENT_AUTHOR = 'bb'.repeat(32);
const SIG = 'cc'.repeat(64);
// Ids that enter a txId preimage are b32 — 64 hex — so a reply's parent and a
// like's target must be well-formed, as they are on the wire.
const BOX_ID = '11'.repeat(32);
const PARENT_ID = 'dd'.repeat(32);
const TARGET_ID = 'ee'.repeat(32);

let signCalls: string[];
let postReads: Array<{ id: string; viewer?: string }>;
let writeCalls: Array<{ kind: 'post' | 'like'; tx: Record<string, unknown>; content?: string }>;

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function karmaResult(boxes: KarmaBoxRow[]): KarmaResult {
  return { userId: PUB, total: '0', effective: '0', boxes, boxCount: boxes.length, next: null, height: 6000 };
}
const FULL_BOXES: KarmaBoxRow[] = [{ boxId: BOX_ID, value: '227' }];
function postResult(id: string, confirmedAuthor: string | null): PostResult {
  return {
    id, content: 'parent', contentHash: '00'.repeat(32), author: 'ff'.repeat(32), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5900, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null, confirmedAuthor,
  };
}

function reads(confirmedAuthor: string | null = PARENT_AUTHOR, boxes: KarmaBoxRow[] = FULL_BOXES): Pick<Api, 'karma' | 'status' | 'post'> {
  return {
    karma: async () => karmaResult(boxes),
    status: async () => statusResult(),
    post: async (id, viewer) => {
      postReads.push({ id, viewer });
      return postResult(id, confirmedAuthor);
    },
  };
}
const identity = {
  current: () => ({ pubKeyHex: PUB }),
  sign: (txId: string) => {
    signCalls.push(txId);
    return SIG;
  },
};
function write(postResp: PostSubmitResult | Rejection, likeResp: LikeSubmitResult | Rejection): SubmitDeps['write'] {
  return {
    submitPost: async (tx, content) => {
      writeCalls.push({ kind: 'post', tx, content });
      return postResp;
    },
    submitLike: async (tx) => {
      writeCalls.push({ kind: 'like', tx });
      return likeResp;
    },
  };
}

const okPost: PostSubmitResult = { postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: 'ignored' };
const okLike: LikeSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };

beforeEach(() => {
  signCalls = [];
  postReads = [];
  writeCalls = [];
  localStorage.clear();
});

describe('submitPostFlow', () => {
  it('builds, signs the id, POSTs { tx, content } and lands a ledger entry', async () => {
    const ledger = new PendingLedger();
    const deps: SubmitDeps = { reads: reads(), write: write(okPost, okLike), ledger, identity };
    const res = await submitPostFlow(deps, 'a thread', null);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The signature is over the client's own computed txId, and it rode the body.
    expect(signCalls).toEqual([res.entry.txId]);
    expect(writeCalls[0]).toMatchObject({ kind: 'post', content: 'a thread' });
    expect((writeCalls[0]!.tx.signatures as Record<string, string>)[PUB]).toBe(SIG);
    // The entry carries the node's postId, the tip height, and is in the ledger.
    expect(res.entry).toMatchObject({ kind: 'post', postId: 'newpost', expiresAtHeight: 6720, submittedAtHeight: 6000 });
    expect(ledger.all().map((e) => e.txId)).toEqual([res.entry.txId]);
    // A root reads no parent.
    expect(postReads).toEqual([]);
  });

  it('a reply resolves the parent confirmedAuthor and addresses the share to it', async () => {
    const ledger = new PendingLedger();
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR), write: write(okPost, okLike), ledger, identity };
    const res = await submitPostFlow(deps, 'a reply', PARENT_ID);

    expect(res.ok).toBe(true);
    expect(postReads).toEqual([{ id: PARENT_ID, viewer: PUB }]);
    const outputs = writeCalls[0]!.tx.outputs as Array<Record<string, unknown>>;
    const accrual = outputs.find((o) => o.boxType === 'like_accrual');
    expect(accrual?.author).toBe(PARENT_AUTHOR);
    const body = writeCalls[0]!.tx.post as Record<string, unknown>;
    expect(body.parentRefs).toEqual([PARENT_ID]);
  });

  it('a rejection short-circuits: no ledger entry', async () => {
    const ledger = new PendingLedger();
    const rejection: Rejection = { status: 503, message: 'mempool full' };
    const deps: SubmitDeps = { reads: reads(), write: write(rejection, okLike), ledger, identity };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res).toEqual({ ok: false, rejection });
    expect(ledger.size).toBe(0);
  });

  it('a parent with no confirmed author is refused client-side before any POST', async () => {
    const ledger = new PendingLedger();
    const deps: SubmitDeps = { reads: reads(null), write: write(okPost, okLike), ledger, identity };
    const res = await submitPostFlow(deps, 'a reply', PARENT_ID);
    expect(res.ok).toBe(false);
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a spendable view that cannot cover the price comes back as one rejection, not a throw', async () => {
    const ledger = new PendingLedger();
    // Four karma cannot cover a thread's price of five.
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, [{ boxId: BOX_ID, value: '4' }]), write: write(okPost, okLike), ledger, identity };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough karma to post right now.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });
});

describe('submitLikeFlow', () => {
  it('resolves the target confirmedAuthor, POSTs { tx }, and lands a like entry', async () => {
    const ledger = new PendingLedger();
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR), write: write(okPost, okLike), ledger, identity };
    const res = await submitLikeFlow(deps, TARGET_ID);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(postReads).toEqual([{ id: TARGET_ID, viewer: PUB }]);
    expect(writeCalls[0]).toMatchObject({ kind: 'like' });
    expect(writeCalls[0]!.tx.likeTarget).toBe(TARGET_ID);
    const outputs = writeCalls[0]!.tx.outputs as Array<Record<string, unknown>>;
    expect(outputs.find((o) => o.boxType === 'like_accrual')?.author).toBe(PARENT_AUTHOR);
    expect(res.entry).toMatchObject({ kind: 'like', postId: TARGET_ID });
    expect(ledger.all().map((e) => e.kind)).toEqual(['like']);
  });

  it('a like rejection short-circuits: no ledger entry', async () => {
    const ledger = new PendingLedger();
    const rejection: Rejection = { status: 409, message: 'Already liked this post' };
    const deps: SubmitDeps = { reads: reads(), write: write(okPost, rejection), ledger, identity };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection });
    expect(ledger.size).toBe(0);
  });

  it('an empty spendable view refuses a like in the voice register', async () => {
    const ledger = new PendingLedger();
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, []), write: write(okPost, okLike), ledger, identity };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough karma to like right now.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });
});
