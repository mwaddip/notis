// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  submitPostFlow, submitLikeFlow, submitVouchFlow, submitUnvouchFlow, submitInviteFlow, submitWithdrawFlow, type SubmitDeps,
} from '../src/wallet/submit';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { KarmaBoxRow, KarmaResult, PostResult, StatusResult, VouchesVoucherResult } from '../src/api/dto';
import { karmaResult as karmaFixture } from './karma-fixture';
import { isRejection } from '../src/api/write';
import type { PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult, WithdrawSubmitResult, Rejection } from '../src/api/write';

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
const VOUCH_TARGET = '22'.repeat(32);
const INVITEE = '33'.repeat(32);
const VOUCH_BOX = '44'.repeat(32);

let signCalls: string[];
let postReads: Array<{ id: string; viewer?: string }>;
let writeCalls: Array<{ kind: 'post' | 'like' | 'vouch' | 'unvouch' | 'invite' | 'withdraw'; tx: Record<string, unknown>; content?: string; targetHex?: string; postId?: string }>;

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function karmaResult(boxes: KarmaBoxRow[]): KarmaResult {
  return karmaFixture({ userId: PUB, boxes, boxCount: boxes.length, height: 6000 });
}
const FULL_BOXES: KarmaBoxRow[] = [{ boxId: BOX_ID, value: '227' }];
function postResult(id: string, confirmedAuthor: string | null): PostResult {
  return {
    id, content: 'parent', contentHash: '00'.repeat(32), author: 'ff'.repeat(32), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5900, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null, confirmedAuthor,
  };
}

function reads(
  confirmedAuthor: string | null = PARENT_AUTHOR,
  boxes: KarmaBoxRow[] = FULL_BOXES,
  vouches: VouchesVoucherResult['vouches'] = [],
): Pick<Api, 'karma' | 'status' | 'post' | 'vouchesByVoucher'> {
  return {
    karma: async () => karmaResult(boxes),
    status: async () => statusResult(),
    post: async (id, viewer) => {
      postReads.push({ id, viewer });
      return postResult(id, confirmedAuthor);
    },
    vouchesByVoucher: async () => ({ vouches, count: vouches.length, next: null }),
  };
}
const vouchRow = (over: Partial<VouchesVoucherResult['vouches'][number]> = {}): VouchesVoucherResult['vouches'][number] => ({
  boxId: VOUCH_BOX, value: '1', createdAtBlock: 5900, voucherId: PUB, targetId: VOUCH_TARGET, ...over,
});
const identity = {
  current: () => ({ pubKeyHex: PUB }),
  sign: (txId: string) => {
    signCalls.push(txId);
    return SIG;
  },
};
// The node echoes the id it computed over the received tx; the client signs its
// own id before POSTing, so the last signed id IS the client's built id — a
// matching node responds with it.
const lastSignedTxId = (): string => signCalls[signCalls.length - 1]!;
const okPost: PostSubmitResult = { postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: 'ignored' };
const okLike: LikeSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okVouch: VouchSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okInvite: InviteSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720, bondBoxId: 'bond1' };
const okWithdraw: WithdrawSubmitResult = { status: 'submitted', txId: 'ignored', postId: 'ignored', expiresAtHeight: 6720 };

function write(
  postResp: PostSubmitResult | Rejection = okPost,
  likeResp: LikeSubmitResult | Rejection = okLike,
  vouchResp: VouchSubmitResult | Rejection = okVouch,
  inviteResp: InviteSubmitResult | Rejection = okInvite,
  unvouchResp: VouchSubmitResult | Rejection = okVouch,
  withdrawResp: WithdrawSubmitResult | Rejection = okWithdraw,
): SubmitDeps['write'] {
  return {
    submitPost: async (tx, content) => {
      writeCalls.push({ kind: 'post', tx, content });
      return isRejection(postResp) ? postResp : { ...postResp, txId: lastSignedTxId() };
    },
    submitLike: async (tx) => {
      writeCalls.push({ kind: 'like', tx });
      return isRejection(likeResp) ? likeResp : { ...likeResp, txId: lastSignedTxId() };
    },
    submitVouch: async (tx) => {
      writeCalls.push({ kind: 'vouch', tx });
      return isRejection(vouchResp) ? vouchResp : { ...vouchResp, txId: lastSignedTxId() };
    },
    submitUnvouch: async (targetHex, tx) => {
      writeCalls.push({ kind: 'unvouch', tx, targetHex });
      return isRejection(unvouchResp) ? unvouchResp : { ...unvouchResp, txId: lastSignedTxId() };
    },
    submitInvite: async (tx) => {
      writeCalls.push({ kind: 'invite', tx });
      return isRejection(inviteResp) ? inviteResp : { ...inviteResp, txId: lastSignedTxId() };
    },
    submitWithdraw: async (postId, tx) => {
      writeCalls.push({ kind: 'withdraw', tx, postId });
      return isRejection(withdrawResp) ? withdrawResp : { ...withdrawResp, txId: lastSignedTxId() };
    },
  };
}

beforeEach(() => {
  signCalls = [];
  postReads = [];
  writeCalls = [];
  localStorage.clear();
});

describe('submitPostFlow', () => {
  it('builds, signs the id, POSTs { tx, content } and lands a ledger entry', async () => {
    const ledger = new PendingLedger(PUB);
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
    const ledger = new PendingLedger(PUB);
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
    const ledger = new PendingLedger(PUB);
    const rejection: Rejection = { status: 503, message: 'mempool full' };
    const deps: SubmitDeps = { reads: reads(), write: write(rejection, okLike), ledger, identity };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res).toEqual({ ok: false, rejection });
    expect(ledger.size).toBe(0);
  });

  it('a parent with no confirmed author is refused client-side before any POST', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(null), write: write(okPost, okLike), ledger, identity };
    const res = await submitPostFlow(deps, 'a reply', PARENT_ID);
    expect(res.ok).toBe(false);
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a spendable view that cannot cover the price comes back as one rejection, not a throw', async () => {
    const ledger = new PendingLedger(PUB);
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
    const ledger = new PendingLedger(PUB);
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
    const ledger = new PendingLedger(PUB);
    const rejection: Rejection = { status: 409, message: 'Already liked this post' };
    const deps: SubmitDeps = { reads: reads(), write: write(okPost, rejection), ledger, identity };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection });
    expect(ledger.size).toBe(0);
  });

  it('an empty spendable view refuses a like in the voice register', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, []), write: write(okPost, okLike), ledger, identity };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough karma to like right now.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });
});

describe('the node txId is compared to the client id', () => {
  // A node whose id disagrees with the client's over the same tx: the encodings
  // diverged, so the entry is refused and the mismatch named.
  function writeMismatch(): SubmitDeps['write'] {
    const wrong = 'ff'.repeat(32);
    return {
      submitPost: async (tx, content) => {
        writeCalls.push({ kind: 'post', tx, content });
        return { ...okPost, txId: wrong };
      },
      submitLike: async (tx) => {
        writeCalls.push({ kind: 'like', tx });
        return { ...okLike, txId: wrong };
      },
      submitVouch: async (tx) => {
        writeCalls.push({ kind: 'vouch', tx });
        return { ...okVouch, txId: wrong };
      },
      submitUnvouch: async (targetHex, tx) => {
        writeCalls.push({ kind: 'unvouch', tx, targetHex });
        return { ...okVouch, txId: wrong };
      },
      submitInvite: async (tx) => {
        writeCalls.push({ kind: 'invite', tx });
        return { ...okInvite, txId: wrong };
      },
      submitWithdraw: async (postId, tx) => {
        writeCalls.push({ kind: 'withdraw', tx, postId });
        return { ...okWithdraw, txId: wrong };
      },
    };
  }

  it('a post whose node id disagrees refuses the entry and names the mismatch', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: writeMismatch(), ledger, identity };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'the node computed a different transaction id' } });
    expect(ledger.size).toBe(0);
  });

  it('a like whose node id disagrees refuses the entry too', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: writeMismatch(), ledger, identity };
    const res = await submitLikeFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'the node computed a different transaction id' } });
    expect(ledger.size).toBe(0);
  });

  it('a withdrawal whose node id disagrees refuses the entry too', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: writeMismatch(), ledger, identity };
    const res = await submitWithdrawFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'the node computed a different transaction id' } });
    expect(ledger.size).toBe(0);
  });
});

describe('submitVouchFlow', () => {
  it('builds, signs the id, POSTs { tx } and lands a vouch entry for the target', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity };
    const res = await submitVouchFlow(deps, VOUCH_TARGET);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(signCalls).toEqual([res.entry.txId]);
    expect(writeCalls[0]).toMatchObject({ kind: 'vouch' });
    expect((writeCalls[0]!.tx.signatures as Record<string, string>)[PUB]).toBe(SIG);
    const outputs = writeCalls[0]!.tx.outputs as Array<Record<string, unknown>>;
    expect(outputs.find((o) => o.boxType === 'vouch')?.targetId).toBe(VOUCH_TARGET);
    expect(res.entry).toMatchObject({ kind: 'vouch', postId: VOUCH_TARGET, expiresAtHeight: 6720, submittedAtHeight: 6000 });
    expect(ledger.all().map((e) => e.kind)).toEqual(['vouch']);
  });

  it('a vouch rejection short-circuits: no ledger entry', async () => {
    const ledger = new PendingLedger(PUB);
    const rejection: Rejection = { status: 400, message: 'already vouched for this pair' };
    const deps: SubmitDeps = { reads: reads(), write: write(okPost, okLike, rejection), ledger, identity };
    const res = await submitVouchFlow(deps, VOUCH_TARGET);
    expect(res).toEqual({ ok: false, rejection });
    expect(ledger.size).toBe(0);
  });

  it('an empty spendable view refuses a vouch in the voice register', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, []), write: write(), ledger, identity };
    const res = await submitVouchFlow(deps, VOUCH_TARGET);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough karma to vouch right now.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });
});

describe('submitUnvouchFlow', () => {
  it('resolves the box at the press, DELETEs { tx } to the target, lands an unvouch entry with no change', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [vouchRow()]), write: write(), ledger, identity };
    const res = await submitUnvouchFlow(deps, VOUCH_TARGET);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(writeCalls[0]).toMatchObject({ kind: 'unvouch', targetHex: VOUCH_TARGET });
    // One input, the resolved vouch box; the voucher's own signature.
    expect(writeCalls[0]!.tx.inputs).toEqual([VOUCH_BOX]);
    expect((writeCalls[0]!.tx.signatures as Record<string, string>)[PUB]).toBe(SIG);
    const outputs = writeCalls[0]!.tx.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.boxType).toBe('vouch_escrow');
    expect(outputs.some((o) => o.boxType === 'karma')).toBe(false);
    expect(res.entry).toMatchObject({ kind: 'unvouch', postId: VOUCH_TARGET, inputs: [VOUCH_BOX] });
    expect(res.entry.change).toBeUndefined();
  });

  it('a pair already gone re-reports withdrawn before any write', async () => {
    const ledger = new PendingLedger(PUB);
    // No vouch row for the target → the box was spent between render and press.
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, []), write: write(), ledger, identity };
    const res = await submitUnvouchFlow(deps, VOUCH_TARGET);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'that vouch was already withdrawn.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a node txId that disagrees refuses the unvouch entry', async () => {
    const ledger = new PendingLedger(PUB);
    const w = write();
    // The node echoes a different id than the client signed → refused.
    w.submitUnvouch = async (targetHex, tx) => { writeCalls.push({ kind: 'unvouch', tx, targetHex }); return { ...okVouch, txId: 'ff'.repeat(32) }; };
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [vouchRow()]), write: w, ledger, identity };
    const res = await submitUnvouchFlow(deps, VOUCH_TARGET);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'the node computed a different transaction id' } });
    expect(ledger.size).toBe(0);
  });
});

describe('submitInviteFlow', () => {
  it('builds, POSTs { tx } and lands an invite entry for the invitee', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity };
    const res = await submitInviteFlow(deps, INVITEE, 100n);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(writeCalls[0]).toMatchObject({ kind: 'invite' });
    const outputs = writeCalls[0]!.tx.outputs as Array<Record<string, unknown>>;
    const bond = outputs.find((o) => o.boxType === 'bond');
    expect(bond?.inviteePublicKey).toBe(INVITEE);
    expect(bond?.value).toBe('100');
    expect(res.entry).toMatchObject({ kind: 'invite', postId: INVITEE });
    expect(ledger.all().map((e) => e.kind)).toEqual(['invite']);
  });

  it('a spendable view below the bond refuses in the voice register', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, [{ boxId: BOX_ID, value: '50' }]), write: write(), ledger, identity };
    const res = await submitInviteFlow(deps, INVITEE, 100n);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough karma to cover the bond right now.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });
});

describe('submitWithdrawFlow', () => {
  it('reads karma then status, signs the id, POSTs { tx } to the post, and lands the entry with the output as change', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity };
    const res = await submitWithdrawFlow(deps, TARGET_ID);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No parent/target read — a withdrawal reads only the spendable view and status.
    expect(postReads).toEqual([]);
    expect(signCalls).toEqual([res.entry.txId]);
    expect(writeCalls[0]).toMatchObject({ kind: 'withdraw', postId: TARGET_ID });
    expect((writeCalls[0]!.tx.signatures as Record<string, string>)[PUB]).toBe(SIG);
    // One karma input, one karma output carrying postWithdraw.
    expect(writeCalls[0]!.tx.inputs).toEqual([BOX_ID]);
    expect(writeCalls[0]!.tx.postWithdraw).toEqual({ postId: TARGET_ID });
    const outputs = writeCalls[0]!.tx.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ boxType: 'karma', value: '227', owner: PUB });
    // The entry carries the body's expiresAtHeight and the output box as change.
    expect(res.entry).toMatchObject({ kind: 'withdraw', postId: TARGET_ID, expiresAtHeight: 6720, submittedAtHeight: 6000 });
    expect(res.entry.change?.value).toBe(227n);
    expect(res.entry.inputs).toEqual([BOX_ID]);
    expect(ledger.all().map((e) => e.kind)).toEqual(['withdraw']);
  });

  it('an empty spendable view refuses in the voice register — no box to sign with', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, []), write: write(), ledger, identity };
    const res = await submitWithdrawFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'no karma box to sign a withdrawal with.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a rejection short-circuits: no ledger entry', async () => {
    const ledger = new PendingLedger(PUB);
    const rejection: Rejection = { status: 403, message: 'not the post author' };
    const deps: SubmitDeps = { reads: reads(), write: write(okPost, okLike, okVouch, okInvite, okVouch, rejection), ledger, identity };
    const res = await submitWithdrawFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection });
    expect(ledger.size).toBe(0);
  });

  it('a 2xx without a numeric expiresAtHeight is a client rejection and adds no entry', async () => {
    const ledger = new PendingLedger(PUB);
    const w = write();
    // A 2xx that echoes the id but carries no expiry height — untrackable, so the
    // flow refuses it and records nothing.
    w.submitWithdraw = async (postId, tx) => {
      writeCalls.push({ kind: 'withdraw', tx, postId });
      return { status: 'submitted', txId: lastSignedTxId(), postId } as WithdrawSubmitResult;
    };
    const deps: SubmitDeps = { reads: reads(), write: w, ledger, identity };
    const res = await submitWithdrawFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'the node answered without an expiry height' } });
    expect(ledger.size).toBe(0);
  });
});
