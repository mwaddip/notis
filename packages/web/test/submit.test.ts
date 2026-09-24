// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  submitPostFlow, submitLikeFlow, submitVouchFlow, submitUnvouchFlow, submitInviteFlow, submitWithdrawFlow, submitClaimFlow, submitBurnFlow, submitSendFlow, type SubmitDeps, type SubmitResult,
} from '../src/wallet/submit';
import { PendingLedger } from '../src/wallet/ledger';
import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { Api } from '../src/api/client';
import type { CreditBoxRow, CreditsResult, KarmaBoxRow, KarmaResult, PostResult, StatusResult, VouchesVoucherResult } from '../src/api/dto';
import { karmaResult as karmaFixture } from './karma-fixture';
import { isRejection } from '../src/api/write';
import type { PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult, WithdrawSubmitResult, ClaimSubmitResult, BurnSubmitResult, SendSubmitResult, Rejection } from '../src/api/write';
import type { UsernameResult } from '../src/api/dto';

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
let writeCalls: Array<{ kind: 'post' | 'like' | 'vouch' | 'unvouch' | 'invite' | 'withdraw' | 'claim' | 'burn' | 'send'; tx: Record<string, unknown>; content?: string; targetHex?: string; postId?: string; name?: string }>;
let creditsCalls: Array<{ key: string; after?: string | null }>;

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
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor,
  };
}

let heldName: UsernameResult | null = null;

function creditsResult(boxes: CreditBoxRow[] = []): CreditsResult {
  const total = boxes.reduce((sum, b) => sum + BigInt(b.value), 0n);
  return { userId: PUB, total: total.toString(), boxes, boxCount: boxes.length, next: null };
}
function reads(
  confirmedAuthor: string | null = PARENT_AUTHOR,
  boxes: KarmaBoxRow[] = FULL_BOXES,
  vouches: VouchesVoucherResult['vouches'] = [],
  creditBoxes: CreditBoxRow[] = [],
): Pick<Api, 'karma' | 'credits' | 'status' | 'post' | 'vouchesByVoucher' | 'usernameByOwner'> {
  return {
    karma: async () => karmaResult(boxes),
    credits: async (key, page) => {
      creditsCalls.push({ key, after: page?.after });
      return creditsResult(creditBoxes);
    },
    status: async () => statusResult(),
    post: async (id, viewer) => {
      postReads.push({ id, viewer });
      return postResult(id, confirmedAuthor);
    },
    vouchesByVoucher: async () => ({ vouches, count: vouches.length, next: null }),
    usernameByOwner: async () => heldName,
  };
}
const vouchRow = (over: Partial<VouchesVoucherResult['vouches'][number]> = {}): VouchesVoucherResult['vouches'][number] => ({
  boxId: VOUCH_BOX, value: '1', createdAtBlock: 5900, voucherId: PUB, targetId: VOUCH_TARGET, voucherName: null, targetName: null, ...over,
});
let signHints: Array<{ content?: string } | undefined>;
const identity = {
  current: () => ({ pubKeyHex: PUB }),
  sign: async (_bytes: Uint8Array, txId: string, hint?: { content?: string }) => {
    signCalls.push(txId);
    signHints.push(hint);
    return { signature: SIG } as const;
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
const okClaim: ClaimSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720, name: 'Alice_01' };
const okBurn: BurnSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };
const okSend: SendSubmitResult = { status: 'pending', txId: 'ignored', expiresAtHeight: 6720 };

function write(
  postResp: PostSubmitResult | Rejection = okPost,
  likeResp: LikeSubmitResult | Rejection = okLike,
  vouchResp: VouchSubmitResult | Rejection = okVouch,
  inviteResp: InviteSubmitResult | Rejection = okInvite,
  unvouchResp: VouchSubmitResult | Rejection = okVouch,
  withdrawResp: WithdrawSubmitResult | Rejection = okWithdraw,
  sendResp: SendSubmitResult | Rejection = okSend,
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
      return isRejection(sendResp) ? sendResp : { ...sendResp, txId: lastSignedTxId() };
    },
  };
}

beforeEach(() => {
  signCalls = [];
  signHints = [];
  postReads = [];
  writeCalls = [];
  creditsCalls = [];
  heldName = null;
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
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough rep to post right now.' } });
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
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough rep to like right now.' } });
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
      submitClaim: async (tx) => {
        writeCalls.push({ kind: 'claim', tx });
        return { ...okClaim, txId: wrong };
      },
      submitBurn: async (name, tx) => {
        writeCalls.push({ kind: 'burn', tx, name });
        return { ...okBurn, txId: wrong };
      },
      submitSend: async (tx) => {
        writeCalls.push({ kind: 'send', tx });
        return { ...okSend, txId: wrong };
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
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough rep to vouch right now.' } });
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
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough rep to cover the bond right now.' } });
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
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'no rep box to sign a withdrawal with.' } });
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

  it('a 2xx without expiresAtHeight records the entry, its expiry the ledger\'s', async () => {
    const ledger = new PendingLedger(PUB);
    const w = write();
    // A 2xx that echoes the id but carries no expiry height: the transaction is
    // the reader's own and may land, so its input stays reserved until the
    // ledger's own bound (WEB_INTERFACE → The wallet).
    w.submitWithdraw = async (postId, tx) => {
      writeCalls.push({ kind: 'withdraw', tx, postId });
      return { status: 'submitted', txId: lastSignedTxId(), postId } as WithdrawSubmitResult;
    };
    const deps: SubmitDeps = { reads: reads(), write: w, ledger, identity };
    const res = await submitWithdrawFlow(deps, TARGET_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry).toMatchObject({ kind: 'withdraw', postId: TARGET_ID, expiresAtHeight: 6720, submittedAtHeight: 6000 });
    expect(ledger.all()).toEqual([res.entry]);
  });
});

describe('submitClaimFlow', () => {
  it('builds, signs the id, POSTs { tx } and lands a claim entry', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity };
    const res = await submitClaimFlow(deps, 'Alice_01');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(signCalls).toEqual([res.entry.txId]);
    expect(writeCalls[0]).toMatchObject({ kind: 'claim' });
    expect((writeCalls[0]!.tx.signatures as Record<string, string>)[PUB]).toBe(SIG);
    expect(res.entry).toMatchObject({ kind: 'claim', postId: 'Alice_01', expiresAtHeight: 6720, submittedAtHeight: 6000 });
    expect(ledger.all().map((e) => e.kind)).toEqual(['claim']);
  });

  it('an empty spendable view refuses — no karma box to sign with', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, []), write: write(), ledger, identity };
    const res = await submitClaimFlow(deps, 'Alice_01');
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'no rep box to sign a claim with.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a rejection short-circuits: no ledger entry', async () => {
    const ledger = new PendingLedger(PUB);
    const w = write();
    w.submitClaim = async (tx) => {
      writeCalls.push({ kind: 'claim', tx });
      return { status: 409, message: 'name taken' };
    };
    const deps: SubmitDeps = { reads: reads(), write: w, ledger, identity };
    const res = await submitClaimFlow(deps, 'Alice_01');
    expect(res).toEqual({ ok: false, rejection: { status: 409, message: 'name taken' } });
    expect(ledger.size).toBe(0);
  });
});

describe('submitBurnFlow', () => {
  it('resolves the name at the press, builds, POSTs to /usernames/:name/burn, and lands a burn entry', async () => {
    heldName = { name: 'Alice_01', owner: PUB, boxId: '44'.repeat(32), claimedAtBlock: 5050 };
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity };
    const res = await submitBurnFlow(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(writeCalls[0]).toMatchObject({ kind: 'burn', name: 'Alice_01' });
    expect(res.entry).toMatchObject({ kind: 'burn', postId: 'Alice_01' });
    expect(ledger.all().map((e) => e.kind)).toEqual(['burn']);
  });

  it('no name held refuses before any POST', async () => {
    heldName = null;
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity };
    const res = await submitBurnFlow(deps);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'this key holds no name.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a spendable view below the price refuses in the voice register', async () => {
    heldName = { name: 'Alice_01', owner: PUB, boxId: '44'.repeat(32), claimedAtBlock: 5050 };
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, [{ boxId: BOX_ID, value: '5' }]), write: write(), ledger, identity };
    const res = await submitBurnFlow(deps);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough rep to burn right now.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });
});

// -------------------------------------------------------------------------
// The notSigned arm — one for each ending a sign attempt can have. The wallet
// short-circuits before the POST, records no entry, and hands the caller a
// shape that names the ending (WEB_INTERFACE → The wallet).
// -------------------------------------------------------------------------

const identityLocked = {
  current: () => ({ pubKeyHex: PUB }),
  sign: async () => ({ locked: true }) as const,
};
const identityDeclined = {
  current: () => ({ pubKeyHex: PUB }),
  sign: async () => ({ declined: true }) as const,
};
const identityRefused = {
  current: () => ({ pubKeyHex: PUB }),
  sign: async () => ({ refused: 'busy' }) as const,
};

describe('the notSigned arm across every flow', () => {
  it('post: locked short-circuits before POST, records no entry', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityLocked };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res).toEqual({ ok: false, notSigned: 'locked', reason: 'your key is locked' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('post: declined short-circuits before POST, records no entry', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityDeclined };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res).toEqual({ ok: false, notSigned: 'declined', reason: 'not sent' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('post: refused carries the reason string through', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityRefused };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res).toEqual({ ok: false, notSigned: 'refused', reason: 'busy' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('like: notSigned short-circuits before POST for each ending', async () => {
    for (const id of [identityLocked, identityDeclined, identityRefused]) {
      const ledger = new PendingLedger(PUB);
      const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR), write: write(), ledger, identity: id };
      const res = await submitLikeFlow(deps, TARGET_ID);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect('notSigned' in res).toBe(true);
      expect(ledger.size).toBe(0);
    }
    expect(writeCalls).toEqual([]);
  });

  it('vouch: notSigned short-circuits before POST', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityDeclined };
    const res = await submitVouchFlow(deps, VOUCH_TARGET);
    expect(res).toEqual({ ok: false, notSigned: 'declined', reason: 'not sent' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('unvouch: notSigned short-circuits before DELETE', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [vouchRow()]), write: write(), ledger, identity: identityLocked };
    const res = await submitUnvouchFlow(deps, VOUCH_TARGET);
    expect(res).toEqual({ ok: false, notSigned: 'locked', reason: 'your key is locked' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('invite: notSigned short-circuits before POST', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityRefused };
    const res = await submitInviteFlow(deps, INVITEE, 100n);
    expect(res).toEqual({ ok: false, notSigned: 'refused', reason: 'busy' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('withdraw: notSigned short-circuits before POST', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityDeclined };
    const res = await submitWithdrawFlow(deps, TARGET_ID);
    expect(res).toEqual({ ok: false, notSigned: 'declined', reason: 'not sent' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('claim: notSigned short-circuits before POST', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityLocked };
    const res = await submitClaimFlow(deps, 'Alice_01');
    expect(res).toEqual({ ok: false, notSigned: 'locked', reason: 'your key is locked' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('burn: notSigned short-circuits before POST', async () => {
    heldName = { name: 'Alice_01', owner: PUB, boxId: '44'.repeat(32), claimedAtBlock: 5050 };
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityRefused };
    const res = await submitBurnFlow(deps);
    expect(res).toEqual({ ok: false, notSigned: 'refused', reason: 'busy' });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });
});

// -------------------------------------------------------------------------
// onSigned — the composer's collapse hook. Called exactly once, exactly
// between the signature and the POST, and only from submitPostFlow. Every
// other flow leaves it unset.
// -------------------------------------------------------------------------

describe('onSigned — the collapse hook fires between sign and POST, only on post', () => {
  it('post: onSigned is called exactly once, after the sign, before the POST', async () => {
    const events: string[] = [];
    const trackedIdentity = {
      current: () => ({ pubKeyHex: PUB }),
      sign: async (_bytes: Uint8Array, txId: string) => {
        signCalls.push(txId);
        events.push('signed');
        return { signature: SIG } as const;
      },
    };
    const trackedWrite = {
      ...write(),
      submitPost: async (tx: Record<string, unknown>, content: string) => {
        events.push('posted');
        writeCalls.push({ kind: 'post', tx, content });
        return { ...okPost, txId: lastSignedTxId() };
      },
    };
    const onSigned = () => events.push('onSigned');
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: trackedWrite, ledger, identity: trackedIdentity, onSigned };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res.ok).toBe(true);
    // Signed, then onSigned, then POST — in that order and exactly once each.
    expect(events).toEqual(['signed', 'onSigned', 'posted']);
  });

  it('post: onSigned is NOT called when the sign ends notSigned', async () => {
    const events: string[] = [];
    const onSigned = () => events.push('onSigned');
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(), write: write(), ledger, identity: identityDeclined, onSigned };
    const res = await submitPostFlow(deps, 'a thread', null);
    expect(res).toEqual({ ok: false, notSigned: 'declined', reason: 'not sent' });
    expect(events).toEqual([]);
  });

  it('the post flow passes { content } as the hint; every other flow passes no hint', async () => {
    heldName = { name: 'Alice_01', owner: PUB, boxId: '44'.repeat(32), claimedAtBlock: 5050 };
    const ledger = new PendingLedger(PUB);
    const base: SubmitDeps = {
      reads: reads(PARENT_AUTHOR, FULL_BOXES, [vouchRow()], [{ boxId: '55'.repeat(32), value: '10000000000' }]),
      write: write(), ledger, identity,
    };
    await submitPostFlow(base, 'the content the prompt verifies', null);
    expect(signHints).toEqual([{ content: 'the content the prompt verifies' }]);
    signHints = [];
    await submitLikeFlow(base, TARGET_ID);
    await submitVouchFlow(base, VOUCH_TARGET);
    await submitUnvouchFlow(base, VOUCH_TARGET);
    await submitInviteFlow(base, INVITEE, 100n);
    await submitWithdrawFlow(base, TARGET_ID);
    await submitClaimFlow(base, 'Alice_01');
    await submitBurnFlow(base);
    await submitSendFlow(base, '44'.repeat(32), null, 1_250_000_000n);
    // Every hint after the first is undefined — no flow but post supplies one.
    expect(signHints.every((h) => h === undefined)).toBe(true);
  });

  it('like, withdraw, vouch, invite, claim, burn, send: onSigned is never called even if supplied', async () => {
    const events: string[] = [];
    heldName = { name: 'Alice_01', owner: PUB, boxId: '44'.repeat(32), claimedAtBlock: 5050 };
    const onSigned = () => events.push('onSigned');
    const ledger = new PendingLedger(PUB);
    const base: SubmitDeps = {
      reads: reads(PARENT_AUTHOR, FULL_BOXES, [vouchRow()], [{ boxId: '55'.repeat(32), value: '10000000000' }]),
      write: write(), ledger, identity, onSigned,
    };
    await submitLikeFlow(base, TARGET_ID);
    await submitVouchFlow(base, VOUCH_TARGET);
    await submitUnvouchFlow(base, VOUCH_TARGET);
    await submitInviteFlow(base, INVITEE, 100n);
    await submitWithdrawFlow(base, TARGET_ID);
    await submitClaimFlow(base, 'Alice_01');
    await submitBurnFlow(base);
    await submitSendFlow(base, '44'.repeat(32), null, 1_250_000_000n);
    expect(events).toEqual([]);
  });
});

describe('submitSendFlow', () => {
  const RECIPIENT = '44'.repeat(32);
  const CREDIT_BOX: CreditBoxRow = { boxId: '55'.repeat(32), value: '10000000000' }; // 100 $NOTIS
  it('reads credits then status, signs the id, POSTs { tx }, lands a send entry naming the recipient and payment box', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [CREDIT_BOX]), write: write(), ledger, identity };
    // toName is the bare name UsernameResult.name gives; the @ is the written
    // form and never stored (WEB_INTERFACE → The identity display).
    const res = await submitSendFlow(deps, RECIPIENT, 'bob', 1_250_000_000n);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Credits were read for the reader's own key, following `next` to the end.
    expect(creditsCalls[0]?.key).toBe(PUB);
    // The signature is over the client's own computed id.
    expect(signCalls).toEqual([res.entry.txId]);
    expect(writeCalls[0]).toMatchObject({ kind: 'send' });
    expect((writeCalls[0]!.tx.signatures as Record<string, string>)[PUB]).toBe(SIG);
    // The tx carries the credit change at index 0 and the payment at index 1.
    const outputs = writeCalls[0]!.tx.outputs as Array<Record<string, unknown>>;
    expect(outputs.map((o) => o.boxType)).toEqual(['credit', 'credit']);
    // The entry names the recipient as postId, carries the SendRef payload, and is in the ledger.
    expect(res.entry).toMatchObject({
      kind: 'send',
      postId: RECIPIENT,
      send: { toHex: RECIPIENT, toName: 'bob', amount: 1_250_000_000n },
      expiresAtHeight: 6720,
      submittedAtHeight: 6000,
    });
    expect(res.entry.send?.boxId).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.all().map((e) => e.txId)).toEqual([res.entry.txId]);
  });

  it('no handle is toName null on the entry', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [CREDIT_BOX]), write: write(), ledger, identity };
    const res = await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.send?.toName).toBeNull();
  });

  it('a send rejection short-circuits: no ledger entry', async () => {
    const ledger = new PendingLedger(PUB);
    const rejection: Rejection = { status: 400, message: 'tx decode' };
    const deps: SubmitDeps = {
      reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [CREDIT_BOX]),
      write: write(okPost, okLike, okVouch, okInvite, okVouch, okWithdraw, rejection),
      ledger, identity,
    };
    const res = await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
    expect(res).toEqual({ ok: false, rejection });
    expect(ledger.size).toBe(0);
  });

  it('a node txId mismatch is a client rejection, no entry', async () => {
    const ledger = new PendingLedger(PUB);
    const w = write();
    const wrong = 'ff'.repeat(32);
    w.submitSend = async (tx) => { writeCalls.push({ kind: 'send', tx }); return { ...okSend, txId: wrong }; };
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [CREDIT_BOX]), write: w, ledger, identity };
    const res = await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'the node computed a different transaction id' } });
    expect(ledger.size).toBe(0);
  });

  it('a 2xx without expiresAtHeight records the entry, its expiry the ledger\'s', async () => {
    const ledger = new PendingLedger(PUB);
    const w = write();
    w.submitSend = async (tx) => { writeCalls.push({ kind: 'send', tx }); return { status: 'pending', txId: lastSignedTxId() } as unknown as SendSubmitResult; };
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [CREDIT_BOX]), write: w, ledger, identity };
    const res = await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry).toMatchObject({ kind: 'send', postId: RECIPIENT, expiresAtHeight: 6720, submittedAtHeight: 6000 });
    expect(ledger.all()).toEqual([res.entry]);
  });

  it('a spendable view that cannot cover the amount is one rejection, not a throw', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = {
      reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [{ boxId: '55'.repeat(32), value: '100' }]),
      write: write(), ledger, identity,
    };
    const res = await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
    expect(res).toEqual({ ok: false, rejection: { status: 0, message: 'not enough $NOTIS.' } });
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a payment below the floor names the floor as $NOTIS', async () => {
    const ledger = new PendingLedger(PUB);
    // One base unit is far below the per-byte floor for a credit output.
    const deps: SubmitDeps = {
      reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [{ boxId: '55'.repeat(32), value: '1' }]),
      write: write(), ledger, identity,
    };
    const res = await submitSendFlow(deps, RECIPIENT, null, 1n);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect('rejection' in res).toBe(true);
    if (!('rejection' in res)) return;
    // The message names the floor formatted as $NOTIS through the denomination module.
    expect(res.rejection.message).toMatch(/^send at least \d+(\.\d+)? \$NOTIS\.$/);
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a change below the floor names the floor and tells the reader to send a little more or all of it', async () => {
    const ledger = new PendingLedger(PUB);
    // One box of value V — send V − 1, which leaves 1 base unit of change (below the floor).
    const deps: SubmitDeps = {
      reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [{ boxId: '55'.repeat(32), value: '10000000000' }]),
      write: write(), ledger, identity,
    };
    const res = await submitSendFlow(deps, RECIPIENT, null, 10000000000n - 1n);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect('rejection' in res).toBe(true);
    if (!('rejection' in res)) return;
    expect(res.rejection.message).toMatch(/^that leaves change under \d+(\.\d+)? \$NOTIS — send a little more, or all of it\.$/);
    expect(writeCalls).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('notSigned in each of the three arms short-circuits before POST', async () => {
    for (const id of [identityLocked, identityDeclined, identityRefused]) {
      const ledger = new PendingLedger(PUB);
      const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [CREDIT_BOX]), write: write(), ledger, identity: id };
      const res = await submitSendFlow(deps, RECIPIENT, null, 1_250_000_000n);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect('notSigned' in res).toBe(true);
      expect(ledger.size).toBe(0);
    }
    expect(writeCalls).toEqual([]);
  });

  it('the send flow passes no hint to sign', async () => {
    const ledger = new PendingLedger(PUB);
    const deps: SubmitDeps = { reads: reads(PARENT_AUTHOR, FULL_BOXES, [], [CREDIT_BOX]), write: write(), ledger, identity };
    await submitSendFlow(deps, RECIPIENT, 'bob', 1_250_000_000n);
    expect(signHints).toEqual([undefined]);
  });
});

// -------------------------------------------------------------------------
// The reservation expiry across the nine flows (WEB_INTERFACE → The wallet →
// "A pending entry's expiry is the client's, and a node's answer can only bring
// it sooner"): a 2xx is recorded whatever its body says of `expiresAtHeight`,
// the entry holds the ledger's bound from the height the transaction was built
// at, and the flow answers the entry the ledger holds; a txId the node computed
// differently is refused in every flow.
// -------------------------------------------------------------------------

describe('the reservation expiry, every flow', () => {
  const BUILT = 6000; // statusResult().blockHeight — the height every output declares
  const OWN = BUILT + MEMPOOL_EXPIRY_BLOCKS;

  /** Every write answers 2xx: the signed id (or another), the route's own
   *  fields, and `expiresAtHeight` as given — left out entirely under `omit`. */
  function writeAnswering(expiresAtHeight: unknown, opts: { omit?: boolean; wrongId?: boolean } = {}): SubmitDeps['write'] {
    const answer = (extra: Record<string, unknown>): never => {
      const body: Record<string, unknown> = { status: 'pending', txId: opts.wrongId ? 'ff'.repeat(32) : lastSignedTxId(), ...extra };
      if (!opts.omit) body.expiresAtHeight = expiresAtHeight;
      return body as never;
    };
    return {
      submitPost: async (tx, content) => { writeCalls.push({ kind: 'post', tx, content }); return answer({ postId: 'newpost' }); },
      submitLike: async (tx) => { writeCalls.push({ kind: 'like', tx }); return answer({}); },
      submitVouch: async (tx) => { writeCalls.push({ kind: 'vouch', tx }); return answer({}); },
      submitUnvouch: async (targetHex, tx) => { writeCalls.push({ kind: 'unvouch', tx, targetHex }); return answer({}); },
      submitInvite: async (tx) => { writeCalls.push({ kind: 'invite', tx }); return answer({ bondBoxId: 'bond1' }); },
      submitWithdraw: async (postId, tx) => { writeCalls.push({ kind: 'withdraw', tx, postId }); return answer({ postId }); },
      submitClaim: async (tx) => { writeCalls.push({ kind: 'claim', tx }); return answer({ name: 'Alice_01' }); },
      submitBurn: async (name, tx) => { writeCalls.push({ kind: 'burn', tx, name }); return answer({}); },
      submitSend: async (tx) => { writeCalls.push({ kind: 'send', tx }); return answer({}); },
    };
  }

  const FLOWS: Array<{ kind: string; run: (deps: SubmitDeps) => Promise<SubmitResult<unknown>> }> = [
    { kind: 'post', run: (d) => submitPostFlow(d, 'a thread', null) },
    { kind: 'like', run: (d) => submitLikeFlow(d, TARGET_ID) },
    { kind: 'vouch', run: (d) => submitVouchFlow(d, VOUCH_TARGET) },
    { kind: 'unvouch', run: (d) => submitUnvouchFlow(d, VOUCH_TARGET) },
    { kind: 'invite', run: (d) => submitInviteFlow(d, INVITEE, 100n) },
    { kind: 'withdraw', run: (d) => submitWithdrawFlow(d, TARGET_ID) },
    { kind: 'claim', run: (d) => submitClaimFlow(d, 'Alice_01') },
    { kind: 'burn', run: (d) => submitBurnFlow(d) },
    { kind: 'send', run: (d) => submitSendFlow(d, '44'.repeat(32), null, 1_250_000_000n) },
  ];

  /** Run every flow on a fresh ledger against one write client. */
  async function eachFlow(
    write: SubmitDeps['write'],
    check: (kind: string, res: SubmitResult<unknown>, ledger: PendingLedger) => void,
  ): Promise<void> {
    for (const f of FLOWS) {
      localStorage.clear();
      heldName = { name: 'Alice_01', owner: PUB, boxId: '44'.repeat(32), claimedAtBlock: 5050 };
      const ledger = new PendingLedger(PUB);
      const deps: SubmitDeps = {
        reads: reads(PARENT_AUTHOR, FULL_BOXES, [vouchRow()], [{ boxId: '55'.repeat(32), value: '10000000000' }]),
        write, ledger, identity,
      };
      check(f.kind, await f.run(deps), ledger);
    }
  }

  it('a later answered height is held at the build height plus MEMPOOL_EXPIRY_BLOCKS, and the flow answers the entry the ledger holds', async () => {
    await eachFlow(writeAnswering(1e15), (kind, res, ledger) => {
      expect(res.ok, kind).toBe(true);
      if (!res.ok) return;
      expect(res.entry.kind).toBe(kind);
      expect([res.entry.submittedAtHeight, res.entry.expiresAtHeight], kind).toEqual([BUILT, OWN]);
      expect(ledger.all()[0], kind).toBe(res.entry);
    });
  });

  it('a 2xx carrying no expiresAtHeight is recorded, held at the client\'s own bound', async () => {
    await eachFlow(writeAnswering(undefined, { omit: true }), (kind, res, ledger) => {
      expect(res.ok, kind).toBe(true);
      if (!res.ok) return;
      expect(res.entry.expiresAtHeight, kind).toBe(OWN);
      expect(ledger.size, kind).toBe(1);
    });
  });

  it('an answered block height below the bound is kept — a node can bring an expiry sooner', async () => {
    await eachFlow(writeAnswering(BUILT + 100), (kind, res) => {
      expect(res.ok, kind).toBe(true);
      if (!res.ok) return;
      expect(res.entry.expiresAtHeight, kind).toBe(BUILT + 100);
    });
  });

  it('a 2xx whose txId is not the built one is refused and records nothing', async () => {
    await eachFlow(writeAnswering(OWN, { wrongId: true }), (kind, res, ledger) => {
      expect(res, kind).toEqual({ ok: false, rejection: { status: 0, message: 'the node computed a different transaction id' } });
      expect(ledger.size, kind).toBe(0);
    });
  });
});
