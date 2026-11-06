// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  submitPostFlow, submitLikeFlow, submitVouchFlow, submitUnvouchFlow,
  submitInviteFlow, submitWithdrawFlow, submitClaimFlow, submitBurnFlow,
  submitSendFlow, type SubmitDeps, type WaitingDeps,
} from '../src/wallet/submit';
import { PendingLedger } from '../src/wallet/ledger';
import { WaitingStore, type WaitingStorage } from '../src/wallet/waiting';
import { fakeLockManager } from './fake-chrome';
import { ApiError } from '../src/api/errors';
import { computePostId } from '@dagsocial/types';
import type { CreditBoxRow, KarmaBoxRow, KarmaResult, PostResult, StatusResult, VouchesVoucherResult, UsernameResult } from '../src/api/dto';
import { karmaResult as karmaFixture } from './karma-fixture';
import type { PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult, WithdrawSubmitResult, ClaimSubmitResult, BurnSubmitResult, SendSubmitResult, Rejection } from '../src/api/write';

// The waiting arm of submit — WEB_INTERFACE → The wallet → "A write no node
// answers waits": with `deps.waiting` present and a chain, a flow whose reads
// or send get no answer is signed and kept in the waiting store, its pending
// entry marked waiting.

const PUB = 'aa'.repeat(32);
const PARENT_AUTHOR = 'bb'.repeat(32);
const SIG = 'cc'.repeat(64);
const BOX_ID = '11'.repeat(32);
const PARENT_ID = 'dd'.repeat(32);
const TARGET_ID = 'ee'.repeat(32);
const VOUCH_TARGET = '22'.repeat(32);
const INVITEE = '33'.repeat(32);
const RECIPIENT = '44'.repeat(32);
const CHAIN = 'ab'.repeat(32);
const NO_ANSWER = new ApiError(0, 'fetch failed');

function fakeStorage(): WaitingStorage {
  const m = new Map<string, string>();
  return {
    get length(): number { return m.size; },
    getItem(k: string): string | null { return m.has(k) ? m.get(k)! : null; },
    setItem(k: string, v: string): void { m.set(k, v); },
    removeItem(k: string): void { m.delete(k); },
    key(i: number): string | null {
      const keys = [...m.keys()];
      return i >= 0 && i < keys.length ? keys[i]! : null;
    },
  };
}

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function karmaResult(boxes: KarmaBoxRow[], effectiveOverride?: string): KarmaResult {
  const effective = effectiveOverride ?? boxes.reduce((sum, b) => sum + BigInt(b.value), 0n).toString();
  return karmaFixture({ userId: PUB, boxes, boxCount: boxes.length, height: 6000, effective });
}

const FULL_BOXES: KarmaBoxRow[] = [{ boxId: BOX_ID, value: '227' }];

function postResult(id: string, confirmedAuthor: string | null): PostResult {
  return {
    id, content: 'parent', contentHash: '00'.repeat(32), author: 'ff'.repeat(32), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5900, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32), confirmedAuthor,
  };
}

/** A read seam that answers every route. Each per-route override lets a case
 *  swap in a throwing or rewritten reader. */
function reads(over: Partial<SubmitDeps['reads']> = {}): SubmitDeps['reads'] {
  return {
    karma: async () => karmaResult(FULL_BOXES),
    credits: async () => ({ userId: PUB, total: '0', boxes: [], boxCount: 0, next: null }),
    status: async () => statusResult(),
    post: async (id) => postResult(id, PARENT_AUTHOR),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    usernameByOwner: async () => null,
    ...over,
  };
}

/** A read seam whose every read throws `isNoAnswer` — status 0. */
function readsAllNoAnswer(): SubmitDeps['reads'] {
  return reads({
    karma: async () => { throw NO_ANSWER; },
    credits: async () => { throw NO_ANSWER; },
    status: async () => { throw NO_ANSWER; },
    post: async () => { throw NO_ANSWER; },
    vouchesByVoucher: async () => { throw NO_ANSWER; },
    usernameByOwner: async () => { throw NO_ANSWER; },
  });
}

let writeCalls: Array<{ kind: string }>;
let signHints: Array<{ content?: string } | undefined>;
let signCalls: string[];

const identity = {
  current: () => ({ pubKeyHex: PUB }),
  sign: async (_bytes: Uint8Array, txId: string, _pubKeyHex: string, hint?: { content?: string }) => {
    signCalls.push(txId);
    signHints.push(hint);
    return { signature: SIG } as const;
  },
};

const lastSignedTxId = (): string => signCalls[signCalls.length - 1]!;

const okPost: PostSubmitResult = { postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: 'ignored' };
const okLike: LikeSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okVouch: VouchSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okInvite: InviteSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720, bondBoxId: 'bond1' };
const okWithdraw: WithdrawSubmitResult = { status: 'submitted', txId: 'ignored', postId: 'ignored', expiresAtHeight: 6720 };
const okClaim: ClaimSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720, name: 'Alice_01' };
const okBurn: BurnSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okSend: SendSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };

const noAnswerRejection: Rejection = { status: 0, message: 'fetch failed', noAnswer: true };

/** A write seam that answers each route today's 2xx with the last-signed
 *  txId echoed, unless the case overrides it. */
function write(over: Partial<SubmitDeps['write']> = {}): SubmitDeps['write'] {
  return {
    submitPost: async () => { writeCalls.push({ kind: 'post' }); return { ...okPost, txId: lastSignedTxId() }; },
    submitLike: async () => { writeCalls.push({ kind: 'like' }); return { ...okLike, txId: lastSignedTxId() }; },
    submitVouch: async () => { writeCalls.push({ kind: 'vouch' }); return { ...okVouch, txId: lastSignedTxId() }; },
    submitUnvouch: async () => { writeCalls.push({ kind: 'unvouch' }); return { ...okVouch, txId: lastSignedTxId() }; },
    submitInvite: async () => { writeCalls.push({ kind: 'invite' }); return { ...okInvite, txId: lastSignedTxId() }; },
    submitWithdraw: async (postId) => { writeCalls.push({ kind: 'withdraw' }); return { ...okWithdraw, txId: lastSignedTxId(), postId }; },
    submitClaim: async () => { writeCalls.push({ kind: 'claim' }); return { ...okClaim, txId: lastSignedTxId() }; },
    submitBurn: async () => { writeCalls.push({ kind: 'burn' }); return { ...okBurn, txId: lastSignedTxId() }; },
    submitSend: async () => { writeCalls.push({ kind: 'send' }); return { ...okSend, txId: lastSignedTxId() }; },
    ...over,
  };
}

/** A write seam that answers every route with the no-answer rejection. */
function writeAllNoAnswer(): SubmitDeps['write'] {
  return write({
    submitPost: async () => { writeCalls.push({ kind: 'post' }); return noAnswerRejection; },
    submitLike: async () => { writeCalls.push({ kind: 'like' }); return noAnswerRejection; },
    submitVouch: async () => { writeCalls.push({ kind: 'vouch' }); return noAnswerRejection; },
    submitUnvouch: async () => { writeCalls.push({ kind: 'unvouch' }); return noAnswerRejection; },
    submitInvite: async () => { writeCalls.push({ kind: 'invite' }); return noAnswerRejection; },
    submitWithdraw: async () => { writeCalls.push({ kind: 'withdraw' }); return noAnswerRejection; },
    submitClaim: async () => { writeCalls.push({ kind: 'claim' }); return noAnswerRejection; },
    submitBurn: async () => { writeCalls.push({ kind: 'burn' }); return noAnswerRejection; },
    submitSend: async () => { writeCalls.push({ kind: 'send' }); return noAnswerRejection; },
  });
}

/** A `WaitingDeps` wired with a real `WaitingStore` over the given storage and
 *  a per-fake lock manager; `chain()` returns the given chain; `cachedAuthor`
 *  reads the given Map. */
function waitingDeps(
  storage: WaitingStorage,
  chain: string | null,
  cache: Map<string, string> = new Map(),
): WaitingDeps {
  const store = new WaitingStore(PUB, { storage, locks: fakeLockManager() });
  return {
    store,
    chain: () => chain,
    cachedAuthor: async (postId) => cache.get(postId) ?? null,
  };
}

/** Record a base through a brief successful read of today's shape, so the
 *  waiting view has somewhere to start. The store is left with the base for
 *  the given ledger on `CHAIN`. */
async function recordBase(storage: WaitingStorage, ledger: 'rep' | 'credits', creditBoxes: CreditBoxRow[] = []): Promise<void> {
  const w = waitingDeps(storage, CHAIN);
  const ledgerPending = new PendingLedger(PUB);
  const deps: SubmitDeps = {
    reads: reads({ credits: async () => ({ userId: PUB, total: '0', boxes: creditBoxes, boxCount: creditBoxes.length, next: null }) }),
    write: write(),
    ledger: ledgerPending,
    identity,
    network: null,
    waiting: w,
  };
  if (ledger === 'rep') {
    // A like on a target reads /karma and /status; the store records the base.
    await submitLikeFlow(deps, TARGET_ID);
  } else {
    await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
  }
  // Drop the test write the base read admitted — later cases start clean.
  writeCalls = [];
  signCalls = [];
  signHints = [];
  // The PendingLedger used above persists through localStorage; later cases
  // construct their own PendingLedger over the same key, which would restore
  // the admitted entry. Clear the per-identity ledger key so later cases
  // start with an empty ledger.
  localStorage.removeItem('notis.pending.' + PUB);
}

beforeEach(() => {
  writeCalls = [];
  signCalls = [];
  signHints = [];
  localStorage.clear();
});

// -------------------------------------------------------------------------
// Each waitable flow waits when its reads get no answer: it builds from the
// recorded waiting view, signs, sends nothing, and keeps the write.
// -------------------------------------------------------------------------

describe('reads with no answer — each flow builds from the view and keeps the write', () => {
  it('post waits when its reads get no answer', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls).toEqual([]); // nothing posted
    expect(w.store.list().map((r) => r.kind)).toEqual(['post']);
    expect(ledger.all().map((e) => ({ kind: e.kind, waiting: e.waiting }))).toEqual([{ kind: 'post', waiting: true }]);
  });

  it('reply waits when its reads get no answer and takes its parent\'s author from the cache', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const cache = new Map<string, string>([[PARENT_ID, PARENT_AUTHOR]]);
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN, cache);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitPostFlow(deps, 'a reply', PARENT_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls).toEqual([]);
    expect(w.store.list().map((r) => r.kind)).toEqual(['post']);
  });

  it('like waits when its reads get no answer and takes its target\'s author from the cache', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const cache = new Map<string, string>([[TARGET_ID, PARENT_AUTHOR]]);
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN, cache);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls).toEqual([]);
    expect(w.store.list().map((r) => r.kind)).toEqual(['like']);
    expect(ledger.all().map((e) => ({ kind: e.kind, waiting: e.waiting }))).toEqual([{ kind: 'like', waiting: true }]);
  });

  it('vouch waits when its reads get no answer', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitVouchFlow(deps, VOUCH_TARGET);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls).toEqual([]);
    expect(w.store.list().map((r) => r.kind)).toEqual(['vouch']);
  });

  it('invite waits when its reads get no answer', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitInviteFlow(deps, INVITEE, 100n);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls).toEqual([]);
    expect(w.store.list().map((r) => r.kind)).toEqual(['invite']);
  });

  it('withdraw waits when its reads get no answer', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitWithdrawFlow(deps, TARGET_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls).toEqual([]);
    expect(w.store.list().map((r) => r.kind)).toEqual(['withdraw']);
  });

  it('claim waits when its reads get no answer', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitClaimFlow(deps, 'Alice_01');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls).toEqual([]);
    expect(w.store.list().map((r) => r.kind)).toEqual(['claim']);
  });

  it('send waits when its reads get no answer', async () => {
    const storage = fakeStorage();
    // A credits base of one 100-$NOTIS box.
    const CREDIT_BOX: CreditBoxRow = { boxId: '55'.repeat(32), value: '10000000000' };
    await recordBase(storage, 'credits', [CREDIT_BOX]);
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls).toEqual([]);
    expect(w.store.list().map((r) => r.kind)).toEqual(['send']);
  });
});

// -------------------------------------------------------------------------
// Each waitable flow waits when its send gets no answer: it runs today's
// path through the sign and the write, and keeps the signed transaction.
// -------------------------------------------------------------------------

describe('send with no answer — each flow keeps its signed transaction', () => {
  it('post waits when its send gets no answer', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: reads(), write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls.map((c) => c.kind)).toEqual(['post']); // sent; no answer
    expect(w.store.list().map((r) => r.kind)).toEqual(['post']);
    expect(ledger.all().map((e) => ({ kind: e.kind, waiting: e.waiting }))).toEqual([{ kind: 'post', waiting: true }]);
  });

  it('reply waits when its send gets no answer', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: reads(), write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    const res = await submitPostFlow(deps, 'a reply', PARENT_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(w.store.list().map((r) => r.kind)).toEqual(['post']);
  });

  it('like waits when its send gets no answer', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: reads(), write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(writeCalls.map((c) => c.kind)).toEqual(['like']);
    expect(w.store.list().map((r) => r.kind)).toEqual(['like']);
  });

  it('vouch waits when its send gets no answer', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: reads(), write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    const res = await submitVouchFlow(deps, VOUCH_TARGET);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(w.store.list().map((r) => r.kind)).toEqual(['vouch']);
  });

  it('invite waits when its send gets no answer', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: reads(), write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    const res = await submitInviteFlow(deps, INVITEE, 100n);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(w.store.list().map((r) => r.kind)).toEqual(['invite']);
  });

  it('withdraw waits when its send gets no answer', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: reads(), write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    const res = await submitWithdrawFlow(deps, TARGET_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(w.store.list().map((r) => r.kind)).toEqual(['withdraw']);
  });

  it('claim waits when its send gets no answer', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: reads(), write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    const res = await submitClaimFlow(deps, 'Alice_01');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(w.store.list().map((r) => r.kind)).toEqual(['claim']);
  });

  it('send waits when its send gets no answer', async () => {
    const storage = fakeStorage();
    const CREDIT_BOX: CreditBoxRow = { boxId: '55'.repeat(32), value: '10000000000' };
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = {
      reads: reads({ credits: async () => ({ userId: PUB, total: '10000000000', boxes: [CREDIT_BOX], boxCount: 1, next: null }) }),
      write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w,
    };
    const res = await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('waiting' in res && res.waiting).toBe(true);
    expect(w.store.list().map((r) => r.kind)).toEqual(['send']);
  });
});

// -------------------------------------------------------------------------
// The cache fallbacks and the arms that fall back to today's path.
// -------------------------------------------------------------------------

describe('reply whose parent the cache lacks ends as today', () => {
  it('rethrows the transport failure', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN); // empty cache
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    await expect(submitPostFlow(deps, 'a reply', PARENT_ID)).rejects.toBeInstanceOf(ApiError);
    expect(writeCalls).toEqual([]);
    expect(w.store.list()).toEqual([]);
  });
});

describe('with no base the flow ends as today', () => {
  it('rethrows the transport failure of the first read', async () => {
    const storage = fakeStorage(); // no recorded base
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    await expect(submitLikeFlow(deps, TARGET_ID)).rejects.toBeInstanceOf(ApiError);
    expect(w.store.list()).toEqual([]);
  });
});

describe('with no chain the flow ends as today', () => {
  it('today\'s path runs (a send-no-answer comes back as the rejection)', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    // chain() answers null — the waiting arm is inactive.
    const w = waitingDeps(storage, null);
    const deps: SubmitDeps = { reads: reads(), write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection: noAnswerRejection });
    expect(w.store.list()).toEqual([]);
    expect(ledger.all()).toEqual([]);
  });
});

describe('a 500 on a read ends as today', () => {
  it('rethrows the 500, no keep', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const err = new ApiError(500, 'node answered 500');
    const deps: SubmitDeps = {
      reads: reads({ karma: async () => { throw err; } }),
      write: write(), ledger, identity, network: null, waiting: w,
    };
    await expect(submitLikeFlow(deps, TARGET_ID)).rejects.toBe(err);
    expect(w.store.list()).toEqual([]);
  });
});

describe('a 409 on the send ends as today', () => {
  it('today\'s rejection, no keep', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const rejection: Rejection = { status: 409, message: 'already liked this post' };
    const deps: SubmitDeps = {
      reads: reads(),
      write: write({ submitLike: async () => { writeCalls.push({ kind: 'like' }); return rejection; } }),
      ledger, identity, network: null, waiting: w,
    };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection });
    expect(w.store.list()).toEqual([]);
    expect(ledger.all()).toEqual([]);
  });
});

describe('a 2xx not of its shape ends as today', () => {
  it('today\'s client rejection, no keep', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    // A client refusal from the write client — a 2xx body that did not parse.
    const bad: Rejection = { status: 0, message: 'the node answered with 200 but its body is not the route\'s shape.' };
    const deps: SubmitDeps = {
      reads: reads(),
      write: write({ submitLike: async () => { writeCalls.push({ kind: 'like' }); return bad; } }),
      ledger, identity, network: null, waiting: w,
    };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection: bad });
    expect(w.store.list()).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// The floor and the view's advance across waiting writes.
// -------------------------------------------------------------------------

describe('the floor holds against the waiting view', () => {
  it('a like whose view answers effective = KARMA_MINIMUM + LIKE_KARMA_COST - 1 refuses', async () => {
    // A view of 2 effective, KARMA_MINIMUM 10 — a like takes 1 and leaves 1,
    // under the floor (WEB_INTERFACE → The wallet → "The floor is the
    // client's to know"). effective = 2 is far below the floor (KARMA_MINIMUM
    // = 10), so a like is refused in the view too.
    const storage = fakeStorage();
    // Record a base with effective 2, boxes 2 — low.
    const w1 = waitingDeps(storage, CHAIN);
    const ledger1 = new PendingLedger(PUB);
    const BOXES: KarmaBoxRow[] = [{ boxId: BOX_ID, value: '2' }];
    const deps1: SubmitDeps = {
      reads: reads({ karma: async () => karmaResult(BOXES, '2') }),
      write: write(), ledger: ledger1, identity, network: null, waiting: w1,
    };
    await submitLikeFlow(deps1, TARGET_ID); // records the base; the flow refuses at the floor
    writeCalls = [];
    signCalls = [];
    // Now reads throw; the waiting view's effective is 2 and the like is floored.
    const w = waitingDeps(storage, CHAIN, new Map([[TARGET_ID, PARENT_AUTHOR]]));
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, notSigned: 'refused', reason: 'the last 10 rep is for posting' });
    expect(w.store.list()).toEqual([]);
    expect(ledger.all()).toEqual([]);
  });
});

describe('a second press builds on the first\'s change', () => {
  it('two waiting likes in a row — the second spends the first\'s change', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const cache = new Map<string, string>([[TARGET_ID, PARENT_AUTHOR]]);
    const w = waitingDeps(storage, CHAIN, cache);
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const r1 = await submitLikeFlow(deps, TARGET_ID);
    expect(r1.ok).toBe(true);
    const r2 = await submitLikeFlow(deps, TARGET_ID);
    expect(r2.ok).toBe(true);
    const writes = w.store.list();
    expect(writes.length).toBe(2);
    // The first spent the view's one box (BOX_ID, value 227), change at 226, cost 1.
    expect(writes[0]!.spent).toEqual([BOX_ID]);
    expect(writes[0]!.cost).toBe(1n);
    // The second spent the first's change id, cost 1.
    expect(writes[1]!.spent).toEqual([writes[0]!.change!.boxId]);
    expect(writes[1]!.cost).toBe(1n);
    // The view's effective dropped by 2 off the base (227) — down to 225.
    const v = w.store.repView(CHAIN)!;
    expect(v.effective).toBe(225n);
  });
});

describe('a press with a node answering builds past a waiting write', () => {
  it('a waiting like, then a like whose reads answer with the own box the waiting like spent — the new like spends the waiting like\'s change', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const cache = new Map<string, string>([[TARGET_ID, PARENT_AUTHOR]]);
    const w = waitingDeps(storage, CHAIN, cache);
    const ledger = new PendingLedger(PUB);

    // First like: reads no answer → waits, spending BOX_ID; its change becomes the view's one box.
    const deps1: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w };
    const r1 = await submitLikeFlow(deps1, TARGET_ID);
    expect(r1.ok).toBe(true);
    const waitingWrite = w.store.list()[0]!;
    const changeBoxId = waitingWrite.change!.boxId;

    // Second like: reads answer with the OWN BOX_ID — the stale view the node
    // has not yet caught up on. The waiting view is advanced on top: the box
    // the waiting write spent is out, its change is in.
    const freshReads = reads(); // defaults to FULL_BOXES = [{ boxId: BOX_ID, value: '227' }]
    const deps2: SubmitDeps = { reads: freshReads, write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w };
    writeCalls = [];
    signCalls = [];
    const r2 = await submitLikeFlow(deps2, TARGET_ID);
    expect(r2.ok).toBe(true);
    const writes = w.store.list();
    expect(writes.length).toBe(2);
    // The new like spent the first's change id, not BOX_ID (which the view the
    // node answered still named).
    expect(writes[1]!.spent).toEqual([changeBoxId]);
  });
});

describe('a waiting post\'s id is computePostId(txId, 0) and it reaches onCachePost', () => {
  it('fires onSigned and onCachePost; the entry\'s postId is the derived id', async () => {
    const storage = fakeStorage();
    await recordBase(storage, 'rep');
    const events: string[] = [];
    let cached: { txId: string } | null = null;
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const deps: SubmitDeps = {
      reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null, waiting: w,
      onSigned: () => events.push('onSigned'),
      onCachePost: (info) => { events.push('onCachePost'); cached = { txId: info.txId }; },
    };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(events).toEqual(['onSigned', 'onCachePost']);
    expect(cached).not.toBeNull();
    expect('waiting' in res && res.waiting).toBe(true);
    // The entry's postId is computePostId(txId, 0).
    const txId = cached!.txId;
    const derived = computePostId(txId, 0);
    expect(res.entry.postId).toBe(derived);
  });
});

describe('without waiting deps a read with no answer throws as today', () => {
  it('no waiting deps → the ApiError rethrows', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: readsAllNoAnswer(), write: write(), ledger, identity, network: null };
    await expect(submitLikeFlow(deps, TARGET_ID)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('unvouch and burn never wait', () => {
  it('unvouch with no node answer ends as today', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const vouchRow: VouchesVoucherResult['vouches'][number] = {
      boxId: '44'.repeat(32), value: '1', createdAtBlock: 5900,
      voucherId: PUB, targetId: VOUCH_TARGET, voucherName: null, targetName: null,
    };
    const deps: SubmitDeps = {
      reads: reads({ vouchesByVoucher: async () => ({ vouches: [vouchRow], count: 1, next: null }) }),
      write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w,
    };
    const res = await submitUnvouchFlow(deps, VOUCH_TARGET);
    // The unvouch flow is unchanged — it returns the rejection as today.
    expect(res.ok).toBe(false);
    expect(w.store.list()).toEqual([]);
  });

  it('burn with no node answer ends as today', async () => {
    const storage = fakeStorage();
    const ledger = new PendingLedger(PUB);
    const w = waitingDeps(storage, CHAIN);
    const held: UsernameResult = { name: 'Alice_01', owner: PUB, boxId: '44'.repeat(32), claimedAtBlock: 5050 };
    const deps: SubmitDeps = {
      reads: reads({ usernameByOwner: async () => held }),
      write: writeAllNoAnswer(), ledger, identity, network: null, waiting: w,
    };
    const res = await submitBurnFlow(deps);
    expect(res.ok).toBe(false);
    expect(w.store.list()).toEqual([]);
  });
});
