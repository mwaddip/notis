import { computePostId, encodeTx, txToJson, hexToBytes, KARMA_MINIMUM, LIKE_KARMA_COST, POST_PRICE_THREAD, POST_PRICE_REPLY, USERNAME_BURN_PRICE, VOUCH_MIN_BALANCE } from '@dagsocial/types';
import type { UtxoTransaction, NetworkType } from '@dagsocial/types';
import { LEDGER_READ_MAX } from '@dagsocial/node-reads';
import { readBuildContext, readCreditContext } from './reads';
import { readWholeList } from '../api/whole-list';
import { networkNumbers } from '../model/network-numbers';
import { buildPost, buildLike, buildVouch, buildUnvouch, buildInvite, buildWithdraw, buildClaim, buildBurn, buildSend, InsufficientKarma, InsufficientCredits, BelowFloor, InvalidKey } from './builders';
import { formatCredits } from '../model/credits';
import { isNoAnswer } from '../api/errors';
import type { PendingLedger } from './ledger';
import type { BuildContext, BuiltTx, RepBuildContext } from './builders';
import type { PendingEntry, ChangeRef, SendRef } from './types';
import type { Api } from '../api/client';
import type { VouchesVoucherResult } from './../api/dto';
import type { WaitingStore, WaitingLedger, WaitingKind } from './waiting';

// WEB_INTERFACE → The wallet → "The floor is the client's to know" — the one
// sentence a judged flow refuses with when the rule bites. `N` is
// KARMA_MINIMUM, the floor the contract names.
const FLOOR_REASON = `the last ${KARMA_MINIMUM} rep is for posting`;

/** The notSigned-refused answer for a judged flow whose own read answered an
 *  `effective` the rule refuses — nothing signed, nothing sent, as a refused
 *  signature does (WEB_INTERFACE → The wallet → "A like, a vouch, an invite
 *  or a burn the rule refuses ends as a refused signature does"). */
function flooredRefusal(): { ok: false; notSigned: 'refused'; reason: string } {
  return { ok: false, notSigned: 'refused', reason: FLOOR_REASON };
}
import type {
  WriteClient, Rejection, PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult, WithdrawSubmitResult, ClaimSubmitResult, BurnSubmitResult, SendSubmitResult,
} from '../api/write';
import { isRejection } from '../api/write';

// The submit orchestration — the one path from a composer press or a like to
// the node: resolve the confirmed author, read the spendable view and the era
// (WEB_INTERFACE → The wallet → "Reads before a write, in this order: `GET /karma/:key?pending=1` following `next`, then `GET /status`"),
// build the transaction, sign it, POST it, and on a 2xx add the ledger entry
// and answer the entry the ledger holds. The ledger holds no input and no
// change (WEB_INTERFACE → The wallet → "An entry holds no input and no
// change"): the spendable views are the node's pending view. A 2xx is recorded
// whether or not its body carries `expiresAtHeight`; the ledger bounds the
// expiry it holds by the height the transaction was built at (WEB_INTERFACE →
// The wallet → "A pending entry's expiry is the client's, and a node's answer
// can only bring it sooner"). A rejection is never retried and comes straight
// back for the caller to show; a send with no answer goes, the same bytes, to
// the next base in the client's order (WEB_INTERFACE → The wallet → "Nothing
// retries a rejection").

/** The four things a sign attempt can end in (WEB_INTERFACE → The identity
 *  module). The in-page module answers `signature`, `locked` or `refused` and
 *  never `declined`; the extension's proxy adds `declined` (and folds a `busy`
 *  case into `refused`). `pending` is the proxy's own business and never surfaces
 *  here. */
export type SignResult =
  | { signature: string }
  | { locked: true }
  | { declined: true }
  | { refused: string };

/** The seam onto the seed — current() carries the public key, sign() the only
 *  path to the seed (WEB_INTERFACE → "sign is the only path to the seed"). The
 *  extension's proxy implements the same shape over the background service
 *  (WEB_INTERFACE → The extension). `txBytes` is `encodeTx` of the unsigned
 *  transaction, so the background decodes and recomputes the id it signs over
 *  rather than trusting the page's claim (WEB_INTERFACE → "`sign`, in the
 *  background, in order"). `pubKeyHex` is the key the flow read from `current()`
 *  when it began and built the transaction for; a key that is not the identity's
 *  is `refused: key-changed`, in both modules, and nothing is signed
 *  (WEB_INTERFACE → "A signature is made for the key the transaction was built
 *  for"). The optional `hint` carries page-supplied display data — a post's
 *  content — verified against the tx's commit before it is shown, so it can
 *  never mislead the human at the prompt. */
export interface Signer {
  current(): { pubKeyHex: string } | null;
  sign(txBytes: Uint8Array, txIdHex: string, pubKeyHex: string, hint?: { content?: string }): Promise<SignResult>;
}

/** The seam a waitable flow uses when the extension carries a waiting store
 *  (WEB_INTERFACE → The wallet → "A write no node answers waits"). Absent in
 *  the web build. */
export interface WaitingDeps {
  /** The persisted store of this identity's waiting writes and the last
   *  spendable view each ledger read (WEB_INTERFACE → The wallet →
   *  "The waiting store keeps every waiting write as a record of its own"). */
  store: WaitingStore;
  /** The chain the client last read, else the remembered one — null while no
   *  verified tip has named one. The waiting arm is inactive while null
   *  (WEB_INTERFACE → The wallet → "The view and every waiting write carry
   *  the chain's name"). */
  chain(): string | null;
  /** The post cache entry's author for a post id, or null for an entry the
   *  cache lacks. A reply's parent or a like's target that the node did not
   *  answer for takes its author from here; a null ends the flow as a
   *  transport failure (WEB_INTERFACE → The wallet → "A write no node answers
   *  waits"). */
  cachedAuthor(postId: string): Promise<string | null>;
}

export interface SubmitDeps {
  reads: Pick<Api, 'karma' | 'credits' | 'status' | 'post' | 'vouchesByVoucher' | 'usernameByOwner'>;
  write: Pick<WriteClient, 'submitPost' | 'submitLike' | 'submitVouch' | 'submitUnvouch' | 'submitInvite' | 'submitWithdraw' | 'submitClaim' | 'submitBurn' | 'submitSend'>;
  ledger: PendingLedger;
  identity: Signer;
  /** The build's network — the App reads it from `prefs`' `BUILD_NETWORK` and
   *  hands it here, so the submit flows import nothing that reads the document
   *  at load (WEB_INTERFACE → Invariants → "A per-network number is read,
   *  never assumed"). An unvouch's `releaseAtBlock` reads
   *  `vouchCooldownBlocks` through `networkNumbers(network, status)`. */
  network: NetworkType | null;
  /** Called after a successful sign and before the POST — the composer path
   *  uses it to collapse into the hollow card in the same slot (WEB_INTERFACE →
   *  The wallet, "the fourth ending is the composer still open"). Only
   *  submitPostFlow calls it; every other flow leaves it unset. */
  onSigned?: () => void;
  /** Called with the signed transaction and its id after a successful post,
   *  so the extension's post cache can hold the reader's own post from its
   *  submit, under the id and from the transaction the client built
   *  (WEB_INTERFACE → The extension → "The post cache"). Only
   *  submitPostFlow calls it; every other flow leaves it unset. */
  onCachePost?: (info: { signedTx: UtxoTransaction; txId: string }) => void;
  /** The extension's waiting seam — the whole flow runs under its lock, a
   *  read that got no answer builds from the view the store holds, and a
   *  write no node answers is kept in it (WEB_INTERFACE → The wallet → "A
   *  write no node answers waits"). The web build leaves it unset and every
   *  flow is exactly today's. */
  waiting?: WaitingDeps;
}

export type SubmitResult<B> =
  | { ok: true; entry: PendingEntry; body: B; waiting?: undefined }
  | { ok: false; rejection: Rejection }
  | { ok: false; notSigned: 'locked' | 'declined' | 'refused'; reason: string };

/** The result shape of a waitable flow — today's `SubmitResult`, plus the
 *  waiting arm the extension can take: signed, kept in the waiting store,
 *  with a ledger entry marked waiting (WEB_INTERFACE → The wallet → "A write
 *  no node answers waits"). The ok arms discriminate on `waiting`:
 *  `undefined` for a sent 2xx, `true` for a waiting write. Unvouch and burn,
 *  which answer `SubmitResult<B>`, can never produce the waiting arm — even
 *  statically. */
export type WaitableResult<B> = SubmitResult<B> | { ok: true; waiting: true; entry: PendingEntry };

/** A client-side refusal (no HTTP round trip) — status 0, message shown as-is. */
function clientRejection(message: string): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: { status: 0, message } };
}

/** Sign the built tx and return the JSON the node accepts, or the `notSigned`
 *  arm the flight ends in (WEB_INTERFACE → The wallet). The signature rides on
 *  the txId, so `signatures[pubKeyHex]` is set on the JSON, not on the tx. */
async function signBody(
  tx: Parameters<typeof txToJson>[0],
  identity: Signer,
  txId: string,
  pubKeyHex: string,
  hint?: { content?: string },
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; notSigned: 'locked' | 'declined' | 'refused'; reason: string }
> {
  const r = await identity.sign(encodeTx(tx), txId, pubKeyHex, hint);
  if ('locked' in r) return { ok: false, notSigned: 'locked', reason: 'your key is locked' };
  if ('declined' in r) return { ok: false, notSigned: 'declined', reason: 'not sent' };
  if ('refused' in r) return { ok: false, notSigned: 'refused', reason: r.refused };
  // Attach the signature to the transaction itself, so a caller holding
  // `tx` sees the signed form (the post cache reads the signed bytes;
  // WEB_INTERFACE → The extension → "The post cache"). `txToJson` reads
  // `tx.signatures` under the one rule.
  tx.signatures = { [pubKeyHex]: hexToBytes(r.signature) };
  const body = txToJson(tx);
  return { ok: true, body };
}

/** Submit a root post (parentId null) or a reply. A reply's share is addressed to
 *  the parent's confirmedAuthor from GET /posts/:id — never the row's `author`. */
export async function submitPostFlow(
  deps: SubmitDeps,
  content: string,
  parentId: string | null,
): Promise<WaitableResult<PostSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitPostFlow: no identity loaded');

  const run = async (): Promise<WaitableResult<PostSubmitResult>> => {
    // A reply resolves its parent's `confirmedAuthor`: first from the node,
    // and in the waiting arm — with no answer — from the post cache
    // (WEB_INTERFACE → The wallet → "A write no node answers waits").
    let parent: { id: string; authorHex: string } | undefined;
    if (parentId !== null) {
      const resolved = await resolveParentOrCached(deps, parentId, id.pubKeyHex);
      if ('rejection' in resolved) return { ok: false, rejection: resolved.rejection };
      parent = { id: parentId, authorHex: resolved.authorHex };
    }
    const ledgerSide: WaitingLedger = 'rep';
    const r = await readsOrWaitingRep(deps, id.pubKeyHex);
    const ctx = r.ctx;
    // The floor against `effective`, read from the view's first page — the
    // same rule the composer holds (WEB_INTERFACE → The wallet → "The floor is
    // the client's to know"): a post refused is a client refusal, not a
    // notSigned ("a post the rule refuses is a client refusal").
    const price = parent ? POST_PRICE_REPLY : POST_PRICE_THREAD;
    if (ctx.effective < price) return clientRejection('not enough rep to post right now.');
    // The composer checks affordability first, but the spendable view is re-read
    // here and can have moved; a shortfall comes back as one rejection shape, not a
    // bare throw the app would have to special-case.
    let built;
    try {
      built = buildPost(ctx, content, parent);
    } catch (e) {
      if (e instanceof InsufficientKarma) return clientRejection('not enough rep to post right now.');
      if (e instanceof InvalidKey) return clientRejection("that post's author key is not valid.");
      throw e;
    }
    // The post's content is the one hint the prompt verifies against the commit
    // (WEB_INTERFACE → "The summary the prompt shows is derived from the
    // transaction"). Every other flow passes no hint.
    const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex, { content });
    if (!signed.ok) return signed;
    // Between the sign and the POST — the composer collapses here (WEB_INTERFACE →
    // The wallet). Post is the only flow that carries onSigned.
    deps.onSigned?.();
    if (r.waiting) {
      // A read got no answer: build and sign against the view, send nothing,
      // keep (WEB_INTERFACE → The wallet → "A write no node answers waits").
      // The waiting post is the reader's submit: it enters the post cache
      // under the id the client derived (WEB_INTERFACE → The extension →
      // "The post cache").
      const entry = keepWaiting(deps, ledgerSide, ctx, built, {
        kind: 'post',
        postId: computePostId(built.txId, 0),
        tx: signed.body,
        content,
      });
      deps.onCachePost?.({ signedTx: built.tx, txId: built.txId });
      return { ok: true, waiting: true, entry };
    }
    const body = await deps.write.submitPost(signed.body, content);
    if (sendIsWaiting(deps, body)) {
      // Send got no answer: the signed transaction waits, and the post
      // enters the cache as a submit does (WEB_INTERFACE → The extension →
      // "The post cache").
      const entry = keepWaiting(deps, ledgerSide, ctx, built, {
        kind: 'post',
        postId: computePostId(built.txId, 0),
        tx: signed.body,
        content,
      });
      deps.onCachePost?.({ signedTx: built.tx, txId: built.txId });
      return { ok: true, waiting: true, entry };
    }
    if (isRejection(body)) return { ok: false, rejection: body };
    // The node echoes the id it computed over the same transaction; a mismatch
    // means the two encodings diverged, so the entry is refused rather than
    // tracked under an id the node does not share.
    if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

    const entry = deps.ledger.add({
      txId: built.txId,
      kind: 'post',
      postId: body.postId, // the node's own id — authoritative, never derived here
      expiresAtHeight: body.expiresAtHeight,
      submittedAtHeight: ctx.height,
    });
    // The reader's own post enters the extension's post cache at its submit —
    // the signed transaction the client built, under the id it derived
    // (WEB_INTERFACE → The extension → "The post cache"). The web build hands
    // the App no cache, which leaves this callback unset.
    deps.onCachePost?.({ signedTx: built.tx, txId: built.txId });
    return { ok: true, entry, body };
  };
  return runUnderLock(deps, run);
}

/** Submit a like: resolve the target's confirmedAuthor, then build and POST. */
export async function submitLikeFlow(deps: SubmitDeps, targetId: string): Promise<WaitableResult<LikeSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitLikeFlow: no identity loaded');

  const run = async (): Promise<WaitableResult<LikeSubmitResult>> => {
    const resolved = await resolveTargetAuthorOrCached(deps, targetId, id.pubKeyHex, 'like');
    if ('rejection' in resolved) return { ok: false, rejection: resolved.rejection };
    const targetAuthor = resolved.authorHex;

    const r = await readsOrWaitingRep(deps, id.pubKeyHex);
    const ctx = r.ctx;
    // The floor against `effective` — a like leaves KARMA_MINIMUM standing
    // (WEB_INTERFACE → The wallet → "The floor is the client's to know"); a
    // like refused ends as a refused signature does.
    if (ctx.effective - LIKE_KARMA_COST < KARMA_MINIMUM) return flooredRefusal();
    let built;
    try {
      built = buildLike(ctx, targetId, targetAuthor);
    } catch (e) {
      if (e instanceof InsufficientKarma) return clientRejection('not enough rep to like right now.');
      if (e instanceof InvalidKey) return clientRejection("that post's author key is not valid.");
      throw e;
    }
    const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
    if (!signed.ok) return signed;
    if (r.waiting) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'like', postId: targetId, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    const body = await deps.write.submitLike(signed.body);
    if (sendIsWaiting(deps, body)) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'like', postId: targetId, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    if (isRejection(body)) return { ok: false, rejection: body };
    if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

    const entry = deps.ledger.add({
      txId: built.txId,
      kind: 'like',
      postId: targetId, // a like has no post id of its own; its target
      expiresAtHeight: body.expiresAtHeight,
      submittedAtHeight: ctx.height,
    });
    return { ok: true, entry, body };
  };
  return runUnderLock(deps, run);
}

/** Submit a vouch for an identity. Karma in, one `vouch` box out; the mark's
 *  optimistic state is the App's, this is the flight (WEB_INTERFACE → The
 *  identity display). */
export async function submitVouchFlow(deps: SubmitDeps, targetKey: string): Promise<WaitableResult<VouchSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitVouchFlow: no identity loaded');

  const run = async (): Promise<WaitableResult<VouchSubmitResult>> => {
    const r = await readsOrWaitingRep(deps, id.pubKeyHex);
    const ctx = r.ctx;
    // The floor against `effective` — a vouch leaves KARMA_MINIMUM standing
    // over its stake (WEB_INTERFACE → The wallet → "The floor is the client's
    // to know"); a vouch refused ends as a refused signature does.
    if (ctx.effective < VOUCH_MIN_BALANCE) return flooredRefusal();
    let built;
    try {
      built = buildVouch(ctx, targetKey);
    } catch (e) {
      if (e instanceof InsufficientKarma) return clientRejection('not enough rep to vouch right now.');
      if (e instanceof InvalidKey) return clientRejection('that is not a valid key.');
      throw e;
    }
    const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
    if (!signed.ok) return signed;
    if (r.waiting) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'vouch', postId: targetKey, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    const body = await deps.write.submitVouch(signed.body);
    if (sendIsWaiting(deps, body)) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'vouch', postId: targetKey, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    if (isRejection(body)) return { ok: false, rejection: body };
    if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

    const entry = deps.ledger.add({
      txId: built.txId,
      kind: 'vouch',
      postId: targetKey, // the identity vouched for
      expiresAtHeight: body.expiresAtHeight,
      submittedAtHeight: ctx.height,
    });
    return { ok: true, entry, body };
  };
  return runUnderLock(deps, run);
}

/** Submit an unvouch. The box is resolved at the press from
 *  `GET /vouches?voucher=<me>`, never from a cached set, since a box can be spent
 *  between a render and a click (WEB_INTERFACE → The wallet). No karma input, no
 *  change; `releaseAtBlock` runs from the cast plus `vouchCooldownBlocks`. */
export async function submitUnvouchFlow(deps: SubmitDeps, targetKey: string): Promise<SubmitResult<VouchSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitUnvouchFlow: no identity loaded');

  const vouch = await resolveVouchBox(deps.reads, id.pubKeyHex, targetKey);
  if (vouch === null) return clientRejection('that vouch was already withdrawn.');

  // No spend, so no /karma pass — only the height and the era from /status, and
  // the cooldown from the one place: the profile where the build names its
  // network, `/status` where it names none (`model/network-numbers.ts`,
  // WEB_INTERFACE → Invariants → "A per-network number is read, never assumed").
  // `releaseAtBlock` is the cast height plus the cooldown (NODE_INTERFACE →
  // Vouch transition rules).
  const status = await deps.reads.status();
  const nn = networkNumbers(deps.network, status);
  if (nn === null) return clientRejection('cannot read the network numbers.');
  const ctx: BuildContext = {
    spendable: [],
    height: status.blockHeight,
    era: status.protocolVersion,
    author: id.pubKeyHex,
  };
  const built = buildUnvouch(
    ctx,
    { boxId: vouch.boxId, value: BigInt(vouch.value), createdAtBlock: vouch.createdAtBlock },
    nn.vouchCooldownBlocks,
  );
  const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
  if (!signed.ok) return signed;
  const body = await deps.write.submitUnvouch(targetKey, signed.body);
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'unvouch',
    postId: targetKey, // the identity unvouched — its box the one input
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** Submit an invite: karma in, one `bond` box out of the chosen amount to the
 *  invitee key (WEB_INTERFACE → The profile window). */
export async function submitInviteFlow(deps: SubmitDeps, inviteeKey: string, bond: bigint): Promise<WaitableResult<InviteSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitInviteFlow: no identity loaded');

  const run = async (): Promise<WaitableResult<InviteSubmitResult>> => {
    const r = await readsOrWaitingRep(deps, id.pubKeyHex);
    const ctx = r.ctx;
    // The floor against `effective` — an invite leaves KARMA_MINIMUM standing
    // over the bond (WEB_INTERFACE → The wallet → "The floor is the client's
    // to know"); an invite refused ends as a refused signature does.
    if (ctx.effective - bond < KARMA_MINIMUM) return flooredRefusal();
    let built;
    try {
      built = buildInvite(ctx, inviteeKey, bond);
    } catch (e) {
      if (e instanceof InsufficientKarma) return clientRejection('not enough rep to cover the bond right now.');
      if (e instanceof InvalidKey) return clientRejection('that is not a valid key.');
      throw e;
    }
    const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
    if (!signed.ok) return signed;
    if (r.waiting) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'invite', postId: inviteeKey, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    const body = await deps.write.submitInvite(signed.body);
    if (sendIsWaiting(deps, body)) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'invite', postId: inviteeKey, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    if (isRejection(body)) return { ok: false, rejection: body };
    if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

    const entry = deps.ledger.add({
      txId: built.txId,
      kind: 'invite',
      postId: inviteeKey, // the key invited
      expiresAtHeight: body.expiresAtHeight,
      submittedAtHeight: ctx.height,
    });
    return { ok: true, entry, body };
  };
  return runUnderLock(deps, run);
}

/** Submit a withdrawal of the reader's own post. The smallest karma box in, one
 *  equal karma output back out, `postWithdraw` naming the post (WEB_INTERFACE →
 *  The withdraw control). */
export async function submitWithdrawFlow(deps: SubmitDeps, postId: string): Promise<WaitableResult<WithdrawSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitWithdrawFlow: no identity loaded');

  const run = async (): Promise<WaitableResult<WithdrawSubmitResult>> => {
    const r = await readsOrWaitingRep(deps, id.pubKeyHex);
    const ctx = r.ctx;
    let built;
    try {
      built = buildWithdraw(ctx, postId);
    } catch (e) {
      if (e instanceof InsufficientKarma) return clientRejection('no rep box to sign a withdrawal with.');
      throw e;
    }
    const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
    if (!signed.ok) return signed;
    if (r.waiting) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'withdraw', postId, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    const body = await deps.write.submitWithdraw(postId, signed.body);
    if (sendIsWaiting(deps, body)) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'withdraw', postId, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    if (isRejection(body)) return { ok: false, rejection: body };
    if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

    const entry = deps.ledger.add({
      txId: built.txId,
      kind: 'withdraw',
      postId, // the post the withdrawal empties
      expiresAtHeight: body.expiresAtHeight,
      submittedAtHeight: ctx.height,
    });
    return { ok: true, entry, body };
  };
  return runUnderLock(deps, run);
}

/** Submit a claim for a username (WEB_INTERFACE → The username row). */
export async function submitClaimFlow(deps: SubmitDeps, name: string): Promise<WaitableResult<ClaimSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitClaimFlow: no identity loaded');

  const run = async (): Promise<WaitableResult<ClaimSubmitResult>> => {
    const r = await readsOrWaitingRep(deps, id.pubKeyHex);
    const ctx = r.ctx;
    let built;
    try {
      built = buildClaim(ctx, name);
    } catch (e) {
      if (e instanceof InsufficientKarma) return clientRejection('no rep box to sign a claim with.');
      throw e;
    }
    const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
    if (!signed.ok) return signed;
    if (r.waiting) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'claim', postId: name, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    const body = await deps.write.submitClaim(signed.body);
    if (sendIsWaiting(deps, body)) {
      const entry = keepWaiting(deps, 'rep', ctx, built, {
        kind: 'claim', postId: name, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    if (isRejection(body)) return { ok: false, rejection: body };
    if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

    const entry = deps.ledger.add({
      txId: built.txId,
      kind: 'claim',
      postId: name,
      expiresAtHeight: body.expiresAtHeight,
      submittedAtHeight: ctx.height,
    });
    return { ok: true, entry, body };
  };
  return runUnderLock(deps, run);
}

/** Submit a burn. The held name and its box are resolved at the press through
 *  `usernameByOwner(me)` — never from the rendered state, since a box can be spent
 *  between a render and a click (WEB_INTERFACE → The wallet). */
export async function submitBurnFlow(deps: SubmitDeps): Promise<SubmitResult<BurnSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitBurnFlow: no identity loaded');

  const held = await deps.reads.usernameByOwner(id.pubKeyHex);
  if (held === null) return clientRejection('this key holds no name.');

  const ctx = await readBuildContext(deps.reads, id.pubKeyHex);
  // The floor against `effective` — a burn leaves KARMA_MINIMUM standing
  // over USERNAME_BURN_PRICE (WEB_INTERFACE → The wallet → "The floor is the
  // client's to know"); a burn refused ends as a refused signature does.
  if (ctx.effective - USERNAME_BURN_PRICE < KARMA_MINIMUM) return flooredRefusal();
  let built;
  try {
    built = buildBurn(ctx, { boxId: held.boxId });
  } catch (e) {
    if (e instanceof InsufficientKarma) return clientRejection('not enough rep to burn right now.');
    throw e;
  }
  const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
  if (!signed.ok) return signed;
  const body = await deps.write.submitBurn(held.name, signed.body);
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'burn',
    postId: held.name,
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** Submit a credits send: credits view in, credit change at index 0 when any,
 *  the payment — one `credit` box of the amount to `toHex` — at the next index,
 *  no `fee` box (WEB_INTERFACE → The wallet). `toName` is the handle the reader
 *  typed, kept for the flight and confirm lines; it never rides the wire — a
 *  signed transaction carries keys only. `BelowFloor` and `InsufficientCredits`
 *  refuse in place with the floor formatted through the denomination module. */
export async function submitSendFlow(
  deps: SubmitDeps,
  toHex: string,
  toName: string | null,
  amount: bigint,
): Promise<WaitableResult<SendSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitSendFlow: no identity loaded');

  const run = async (): Promise<WaitableResult<SendSubmitResult>> => {
    const r = await readsOrWaitingCredits(deps, id.pubKeyHex);
    const ctx = r.ctx;
    let built;
    try {
      built = buildSend(ctx, toHex, amount);
    } catch (e) {
      if (e instanceof InsufficientCredits) return clientRejection('not enough $NOTIS.');
      if (e instanceof InvalidKey) return clientRejection('that is not a valid key.');
      if (e instanceof BelowFloor) {
        const floor = formatCredits(e.floor);
        return clientRejection(
          e.which === 'payment'
            ? `send at least ${floor} $NOTIS.`
            : `that leaves change under ${floor} $NOTIS — send a little more, or all of it.`,
        );
      }
      throw e;
    }
    const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
    if (!signed.ok) return signed;
    const send: SendRef = { toHex, toName, amount, boxId: built.paymentBoxId };
    if (r.waiting) {
      const entry = keepWaiting(deps, 'credits', ctx, built, {
        kind: 'send', postId: toHex, send, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    const body = await deps.write.submitSend(signed.body);
    if (sendIsWaiting(deps, body)) {
      const entry = keepWaiting(deps, 'credits', ctx, built, {
        kind: 'send', postId: toHex, send, tx: signed.body,
      });
      return { ok: true, waiting: true, entry };
    }
    if (isRejection(body)) return { ok: false, rejection: body };
    if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

    const entry = deps.ledger.add({
      txId: built.txId,
      kind: 'send',
      postId: toHex, // a send's subject is the recipient's key
      send,
      expiresAtHeight: body.expiresAtHeight,
      submittedAtHeight: ctx.height,
    });
    return { ok: true, entry, body };
  };
  return runUnderLock(deps, run);
}

// ---------------------------------------------------------------------------
// The waiting arm — WEB_INTERFACE → The wallet → "A write no node answers
// waits". Each helper takes `deps`, so a flow called without `deps.waiting`
// or with `deps.waiting.chain()` null runs exactly today's path: the lock
// wrapper is a no-op, the reads throw their own errors, and `sendIsWaiting`
// stays false.
// ---------------------------------------------------------------------------

/** True once the extension carries a waiting seam AND a verified tip has
 *  named a chain (WEB_INTERFACE → The wallet → "The view and every waiting
 *  write carry the chain's name"). Any other state runs today's path. */
function activeWaiting(deps: SubmitDeps): { store: WaitingStore; chain: string; cachedAuthor: WaitingDeps['cachedAuthor'] } | null {
  const w = deps.waiting;
  if (w === undefined) return null;
  const chain = w.chain();
  if (chain === null) return null;
  return { store: w.store, chain, cachedAuthor: w.cachedAuthor };
}

/** Run a flow under the identity's waiting lock when the arm is active, so
 *  two pages build in turn — with no arm, a direct call (WEB_INTERFACE → The
 *  wallet → "The waiting store keeps every waiting write as a record of its
 *  own"). */
function runUnderLock<T>(deps: SubmitDeps, fn: () => Promise<T>): Promise<T> {
  const active = activeWaiting(deps);
  if (active === null) return fn();
  return active.store.withLock(fn);
}

/** The rep-side reader, else the waiting view with no answer, else today's
 *  error (WEB_INTERFACE → The wallet → "The waiting view"). When the arm is
 *  active the flow builds from `repView(chain)`: the base alone when nothing
 *  waits, the base advanced by every waiting write when some do, so a press
 *  never spends a box a waiting write spent. */
async function readsOrWaitingRep(deps: SubmitDeps, author: string): Promise<{ ctx: RepBuildContext; waiting: boolean }> {
  const active = activeWaiting(deps);
  try {
    const ctx = await readBuildContext(deps.reads, author);
    if (active === null) return { ctx, waiting: false };
    active.store.recordBase('rep', ctx, active.chain);
    const advanced = active.store.repView(active.chain);
    // Totality: the base was just recorded for this chain, so the view is
    // never null — the fallthrough keeps the recorded base, as `repView`
    // would answer.
    return { ctx: advanced ?? ctx, waiting: false };
  } catch (e) {
    if (active === null || !isNoAnswer(e)) throw e;
    const view = active.store.repView(active.chain);
    if (view === null) throw e;
    return { ctx: view, waiting: true };
  }
}

/** The credit-side counterpart (WEB_INTERFACE → The wallet → "The waiting
 *  view"). */
async function readsOrWaitingCredits(deps: SubmitDeps, author: string): Promise<{ ctx: BuildContext; waiting: boolean }> {
  const active = activeWaiting(deps);
  try {
    const ctx = await readCreditContext(deps.reads, author);
    if (active === null) return { ctx, waiting: false };
    active.store.recordBase('credits', ctx, active.chain);
    const advanced = active.store.creditView(active.chain);
    return { ctx: advanced ?? ctx, waiting: false };
  } catch (e) {
    if (active === null || !isNoAnswer(e)) throw e;
    const view = active.store.creditView(active.chain);
    if (view === null) throw e;
    return { ctx: view, waiting: true };
  }
}

/** Resolve a reply's parent: `reads.post` as today, with the cache as the
 *  waiting fallback (WEB_INTERFACE → The wallet → "A write no node answers
 *  waits"). Null `confirmedAuthor` is the client rejection the parent flow
 *  carries whatever the arm. */
async function resolveParentOrCached(
  deps: SubmitDeps,
  parentId: string,
  viewerKey: string,
): Promise<{ authorHex: string } | { rejection: Rejection }> {
  const active = activeWaiting(deps);
  try {
    const p = await deps.reads.post(parentId, viewerKey);
    if (!p || p.confirmedAuthor === null) {
      return { rejection: { status: 0, message: 'that post has no confirmed author to reply under.' } };
    }
    return { authorHex: p.confirmedAuthor };
  } catch (e) {
    if (active === null || !isNoAnswer(e)) throw e;
    const cached = await active.cachedAuthor(parentId);
    if (cached === null) throw e;
    return { authorHex: cached };
  }
}

/** Resolve a like's target author: `reads.post` as today, cache as the
 *  waiting fallback. */
async function resolveTargetAuthorOrCached(
  deps: SubmitDeps,
  targetId: string,
  viewerKey: string,
  _flow: 'like',
): Promise<{ authorHex: string } | { rejection: Rejection }> {
  const active = activeWaiting(deps);
  try {
    const t = await deps.reads.post(targetId, viewerKey);
    if (!t || t.confirmedAuthor === null) {
      return { rejection: { status: 0, message: 'that post has no confirmed author to like.' } };
    }
    return { authorHex: t.confirmedAuthor };
  } catch (e) {
    if (active === null || !isNoAnswer(e)) throw e;
    const cached = await active.cachedAuthor(targetId);
    if (cached === null) throw e;
    return { authorHex: cached };
  }
}

/** The write-client's *no answer* mark — the status-0 `noAnswer: true`
 *  rejection the `send` loop answers with once every base has failed
 *  (WEB_INTERFACE → The wallet → "A write no node answers waits"). True only
 *  when the waiting arm is active: with no arm, the web build's send takes
 *  today's transport-failure path through the rejection. */
function sendIsWaiting(deps: SubmitDeps, body: unknown): boolean {
  if (activeWaiting(deps) === null) return false;
  return typeof body === 'object' && body !== null
    && (body as { status?: unknown }).status === 0
    && (body as { noAnswer?: unknown }).noAnswer === true;
}

/** Keep one waiting write and its ledger entry: the record under the store's
 *  lock seq, and a pending entry marked waiting with no expiry while it
 *  waits (WEB_INTERFACE → The wallet → "A write no node answers waits",
 *  → "A pending entry's expiry is the client's, and a node's answer can
 *  only bring it sooner"). The caller holds the active arm. */
function keepWaiting(
  deps: SubmitDeps,
  ledger: WaitingLedger,
  ctx: BuildContext | RepBuildContext,
  built: BuiltTx,
  spec: { kind: WaitingKind; postId: string; send?: SendRef; tx: Record<string, unknown>; content?: string },
): PendingEntry {
  const active = activeWaiting(deps);
  if (active === null) {
    // Unreachable in the waitable flows — guarded by the caller — but kept
    // total so a future caller cannot slip into a waiting path with no store.
    throw new Error('keepWaiting: no active waiting arm');
  }
  const spent = built.tx.inputs;
  const change: ChangeRef | null = built.change;
  const cost = costOf(ctx.spendable, spent, change);
  active.store.keep({
    chain: active.chain,
    ledger,
    txId: built.txId,
    kind: spec.kind,
    postId: spec.postId,
    ...(spec.send !== undefined ? { send: spec.send } : {}),
    tx: spec.tx,
    ...(spec.content !== undefined ? { content: spec.content } : {}),
    spent: [...spent],
    change,
    cost,
    builtAtHeight: ctx.height,
  });
  return deps.ledger.add({
    txId: built.txId,
    kind: spec.kind,
    postId: spec.postId,
    ...(spec.send !== undefined ? { send: spec.send } : {}),
    waiting: true,
    expiresAtHeight: null,
    submittedAtHeight: ctx.height,
  });
}

/** The waiting write's `cost`: the sum of the spent boxes' values in the
 *  view, less the change's value (WEB_INTERFACE → The wallet → "The waiting
 *  store keeps every waiting write as a record of its own"). */
function costOf(
  spendable: readonly { boxId: string; value: bigint }[],
  spent: readonly string[],
  change: ChangeRef | null,
): bigint {
  const spentSet = new Set(spent);
  let sum = 0n;
  for (const b of spendable) if (spentSet.has(b.boxId)) sum += b.value;
  return sum - (change?.value ?? 0n);
}

// ---------------------------------------------------------------------------

/** The reader's live `vouch` box naming `targetKey`, resolved at the press by
 *  reading `GET /vouches?voucher=<me>` whole — null when the pair stands no
 *  more (WEB_INTERFACE → The wallet, → Reading a node's answer → "A whole-list
 *  read is bounded"). The listing is bounded by LEDGER_READ_MAX. */
async function resolveVouchBox(
  reads: Pick<Api, 'vouchesByVoucher'>,
  voucherKey: string,
  targetKey: string,
): Promise<{ boxId: string; value: string; createdAtBlock: number } | null> {
  const vouches = await readWholeList<VouchesVoucherResult['vouches'][number], VouchesVoucherResult>({
    readPage: (page) => reads.vouchesByVoucher(voucherKey, page),
    pick: (answer) => ({ rows: answer.vouches, next: answer.next }),
    keyOf: (v) => v.boxId,
    bound: LEDGER_READ_MAX,
  });
  const row = vouches.find((v) => v.targetId === targetKey);
  if (row) return { boxId: row.boxId, value: row.value, createdAtBlock: row.createdAtBlock };
  return null;
}

