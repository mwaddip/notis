import { encodeTx } from '@dagsocial/types';
import { readBuildContext, readCreditContext } from './reads';
import { buildPost, buildLike, buildVouch, buildUnvouch, buildInvite, buildWithdraw, buildClaim, buildBurn, buildSend, txToJson, InsufficientKarma, InsufficientCredits, BelowFloor } from './builders';
import { formatCredits } from '../model/credits';
import type { PendingLedger } from './ledger';
import type { BuildContext } from './builders';
import type { PendingEntry } from './types';
import type { Api } from '../api/client';
import type {
  WriteClient, Rejection, PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult, WithdrawSubmitResult, ClaimSubmitResult, BurnSubmitResult, SendSubmitResult,
} from '../api/write';
import { isRejection } from '../api/write';

// The submit orchestration — the one path from a composer press or a like to
// the node: resolve the confirmed author, read the spendable view and the era
// (WEB_INTERFACE → "Reads before a write, in this order: `GET /karma/:key` following `next`, then `GET /status`"),
// build the transaction, sign it, POST it, and on a 2xx add the ledger entry
// and answer the entry the ledger holds. A 2xx is recorded whether or not its
// body carries `expiresAtHeight`; the ledger bounds the expiry it holds by the
// height the transaction was built at (WEB_INTERFACE → The wallet → "A pending
// entry's expiry is the client's, and a node's answer can only bring it sooner").
// Nothing retries (WEB_INTERFACE → "Nothing retries"): a rejection comes
// straight back for the caller to show.

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
 *  background, in order"). The optional `hint` carries page-supplied display
 *  data — a post's content — verified against the tx's commit before it is
 *  shown, so it can never mislead the human at the prompt. */
export interface Signer {
  current(): { pubKeyHex: string } | null;
  sign(txBytes: Uint8Array, txIdHex: string, hint?: { content?: string }): Promise<SignResult>;
}

export interface SubmitDeps {
  reads: Pick<Api, 'karma' | 'credits' | 'status' | 'post' | 'vouchesByVoucher' | 'usernameByOwner'>;
  write: Pick<WriteClient, 'submitPost' | 'submitLike' | 'submitVouch' | 'submitUnvouch' | 'submitInvite' | 'submitWithdraw' | 'submitClaim' | 'submitBurn' | 'submitSend'>;
  ledger: PendingLedger;
  identity: Signer;
  /** Called after a successful sign and before the POST — the composer path
   *  uses it to collapse into the hollow card in the same slot (WEB_INTERFACE →
   *  The wallet, "the fourth ending is the composer still open"). Only
   *  submitPostFlow calls it; every other flow leaves it unset. */
  onSigned?: () => void;
}

export type SubmitResult<B> =
  | { ok: true; entry: PendingEntry; body: B }
  | { ok: false; rejection: Rejection }
  | { ok: false; notSigned: 'locked' | 'declined' | 'refused'; reason: string };

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
  const r = await identity.sign(encodeTx(tx), txId, hint);
  if ('locked' in r) return { ok: false, notSigned: 'locked', reason: 'your key is locked' };
  if ('declined' in r) return { ok: false, notSigned: 'declined', reason: 'not sent' };
  if ('refused' in r) return { ok: false, notSigned: 'refused', reason: r.refused };
  const body = txToJson(tx);
  body.signatures = { [pubKeyHex]: r.signature };
  return { ok: true, body };
}

/** Submit a root post (parentId null) or a reply. A reply's share is addressed to
 *  the parent's confirmedAuthor from GET /posts/:id — never the row's `author`. */
export async function submitPostFlow(
  deps: SubmitDeps,
  content: string,
  parentId: string | null,
): Promise<SubmitResult<PostSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitPostFlow: no identity loaded');

  let parent: { id: string; authorHex: string } | undefined;
  if (parentId !== null) {
    const p = await deps.reads.post(parentId, id.pubKeyHex);
    if (!p || p.confirmedAuthor === null) {
      return clientRejection('that post has no confirmed author to reply under.');
    }
    parent = { id: parentId, authorHex: p.confirmedAuthor };
  }

  const ctx = await readBuildContext(deps.reads, deps.ledger, id.pubKeyHex);
  // The composer checks affordability first, but the spendable view is re-read
  // here and can have moved; a shortfall comes back as one rejection shape, not a
  // bare throw the app would have to special-case.
  let built;
  try {
    built = buildPost(ctx, content, parent);
  } catch (e) {
    if (e instanceof InsufficientKarma) return clientRejection('not enough rep to post right now.');
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
  const body = await deps.write.submitPost(signed.body, content);
  if (isRejection(body)) return { ok: false, rejection: body };
  // The node echoes the id it computed over the same transaction; a mismatch
  // means the two encodings diverged, so the entry is refused rather than
  // tracked under an id the node does not share.
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'post',
    postId: body.postId, // the node's own id — authoritative, never derived here
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** Submit a like: resolve the target's confirmedAuthor, then build and POST. */
export async function submitLikeFlow(deps: SubmitDeps, targetId: string): Promise<SubmitResult<LikeSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitLikeFlow: no identity loaded');

  const target = await deps.reads.post(targetId, id.pubKeyHex);
  if (!target || target.confirmedAuthor === null) {
    return clientRejection('that post has no confirmed author to like.');
  }

  const ctx = await readBuildContext(deps.reads, deps.ledger, id.pubKeyHex);
  let built;
  try {
    built = buildLike(ctx, targetId, target.confirmedAuthor);
  } catch (e) {
    if (e instanceof InsufficientKarma) return clientRejection('not enough rep to like right now.');
    throw e;
  }
  const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
  if (!signed.ok) return signed;
  const body = await deps.write.submitLike(signed.body);
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'like',
    postId: targetId, // a like has no post id of its own; its target
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** Submit a vouch for an identity. Karma in, one `vouch` box out; the mark's
 *  optimistic state is the App's, this is the flight (WEB_INTERFACE → The
 *  identity display). */
export async function submitVouchFlow(deps: SubmitDeps, targetKey: string): Promise<SubmitResult<VouchSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitVouchFlow: no identity loaded');

  const ctx = await readBuildContext(deps.reads, deps.ledger, id.pubKeyHex);
  let built;
  try {
    built = buildVouch(ctx, targetKey);
  } catch (e) {
    if (e instanceof InsufficientKarma) return clientRejection('not enough rep to vouch right now.');
    throw e;
  }
  const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
  if (!signed.ok) return signed;
  const body = await deps.write.submitVouch(signed.body);
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'vouch',
    postId: targetKey, // the identity vouched for
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
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

  // No spend, so no /karma pass — only the height, the era and the cooldown, all
  // from /status. `releaseAtBlock` is the cast height plus the cooldown
  // (NODE_INTERFACE → Vouch transition rules).
  const status = await deps.reads.status();
  const ctx: BuildContext = {
    spendable: [],
    height: status.blockHeight,
    era: status.protocolVersion,
    author: id.pubKeyHex,
  };
  const built = buildUnvouch(
    ctx,
    { boxId: vouch.boxId, value: BigInt(vouch.value), createdAtBlock: vouch.createdAtBlock },
    status.vouchCooldownBlocks,
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
    inputs: built.tx.inputs,
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** Submit an invite: karma in, one `bond` box out of the chosen amount to the
 *  invitee key (WEB_INTERFACE → The profile window). */
export async function submitInviteFlow(deps: SubmitDeps, inviteeKey: string, bond: bigint): Promise<SubmitResult<InviteSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitInviteFlow: no identity loaded');

  const ctx = await readBuildContext(deps.reads, deps.ledger, id.pubKeyHex);
  let built;
  try {
    built = buildInvite(ctx, inviteeKey, bond);
  } catch (e) {
    if (e instanceof InsufficientKarma) return clientRejection('not enough rep to cover the bond right now.');
    throw e;
  }
  const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
  if (!signed.ok) return signed;
  const body = await deps.write.submitInvite(signed.body);
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'invite',
    postId: inviteeKey, // the key invited
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** Submit a withdrawal of the reader's own post. The smallest karma box in, one
 *  equal karma output back out, `postWithdraw` naming the post (WEB_INTERFACE →
 *  The withdraw control). */
export async function submitWithdrawFlow(deps: SubmitDeps, postId: string): Promise<SubmitResult<WithdrawSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitWithdrawFlow: no identity loaded');

  const ctx = await readBuildContext(deps.reads, deps.ledger, id.pubKeyHex);
  let built;
  try {
    built = buildWithdraw(ctx, postId);
  } catch (e) {
    if (e instanceof InsufficientKarma) return clientRejection('no rep box to sign a withdrawal with.');
    throw e;
  }
  const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
  if (!signed.ok) return signed;
  const body = await deps.write.submitWithdraw(postId, signed.body);
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'withdraw',
    postId, // the post the withdrawal empties
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** Submit a claim for a username (WEB_INTERFACE → The username row). */
export async function submitClaimFlow(deps: SubmitDeps, name: string): Promise<SubmitResult<ClaimSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitClaimFlow: no identity loaded');

  const ctx = await readBuildContext(deps.reads, deps.ledger, id.pubKeyHex);
  let built;
  try {
    built = buildClaim(ctx, name);
  } catch (e) {
    if (e instanceof InsufficientKarma) return clientRejection('no rep box to sign a claim with.');
    throw e;
  }
  const signed = await signBody(built.tx, deps.identity, built.txId, id.pubKeyHex);
  if (!signed.ok) return signed;
  const body = await deps.write.submitClaim(signed.body);
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'claim',
    postId: name,
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** Submit a burn. The held name and its box are resolved at the press through
 *  `usernameByOwner(me)` — never from the rendered state, since a box can be spent
 *  between a render and a click (WEB_INTERFACE → The wallet). */
export async function submitBurnFlow(deps: SubmitDeps): Promise<SubmitResult<BurnSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitBurnFlow: no identity loaded');

  const held = await deps.reads.usernameByOwner(id.pubKeyHex);
  if (held === null) return clientRejection('this key holds no name.');

  const ctx = await readBuildContext(deps.reads, deps.ledger, id.pubKeyHex);
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
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
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
): Promise<SubmitResult<SendSubmitResult>> {
  const id = deps.identity.current();
  if (id === null) throw new Error('submitSendFlow: no identity loaded');

  const ctx = await readCreditContext(deps.reads, deps.ledger, id.pubKeyHex);
  let built;
  try {
    built = buildSend(ctx, toHex, amount);
  } catch (e) {
    if (e instanceof InsufficientCredits) return clientRejection('not enough $NOTIS.');
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
  const body = await deps.write.submitSend(signed.body);
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry = deps.ledger.add({
    txId: built.txId,
    kind: 'send',
    postId: toHex, // a send's subject is the recipient's key
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    send: { toHex, toName, amount, boxId: built.paymentBoxId },
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  });
  return { ok: true, entry, body };
}

/** The reader's live `vouch` box naming `targetKey`, resolved at the press by
 *  following `next` to the end of `GET /vouches?voucher=<me>` — null when the pair
 *  is gone (WEB_INTERFACE → The wallet). */
async function resolveVouchBox(
  reads: Pick<Api, 'vouchesByVoucher'>,
  voucherKey: string,
  targetKey: string,
): Promise<{ boxId: string; value: string; createdAtBlock: number } | null> {
  let after: string | null = null;
  do {
    const page = await reads.vouchesByVoucher(voucherKey, after === null ? {} : { after });
    const row = page.vouches.find((v) => v.targetId === targetKey);
    if (row) return { boxId: row.boxId, value: row.value, createdAtBlock: row.createdAtBlock };
    after = page.next;
  } while (after !== null);
  return null;
}

