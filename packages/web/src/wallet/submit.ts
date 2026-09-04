import { readBuildContext } from './reads';
import { buildPost, buildLike, buildVouch, buildUnvouch, buildInvite, txToJson, InsufficientKarma } from './builders';
import type { PendingLedger } from './ledger';
import type { BuildContext } from './builders';
import type { PendingEntry } from './types';
import type { Api } from '../api/client';
import type {
  WriteClient, Rejection, PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult,
} from '../api/write';
import { isRejection } from '../api/write';

// The submit orchestration — the one path from a composer press or a like to the
// node: resolve the confirmed author, read the spendable view and era (§5.1
// order), build the transaction, sign it, POST it, and on a 2xx add the ledger
// entry. Nothing retries (WEB_INTERFACE → "Nothing retries"): a rejection comes
// straight back for the caller to show.

/** The seam onto the seed — current() carries the public key, sign() the only
 *  path to the seed (WEB_INTERFACE → "sign is the only path to the seed"). */
export interface Signer {
  current(): { pubKeyHex: string } | null;
  sign(txIdHex: string): string;
}

export interface SubmitDeps {
  reads: Pick<Api, 'karma' | 'status' | 'post' | 'vouchesByVoucher'>;
  write: Pick<WriteClient, 'submitPost' | 'submitLike' | 'submitVouch' | 'submitUnvouch' | 'submitInvite'>;
  ledger: PendingLedger;
  identity: Signer;
}

export type SubmitResult<B> =
  | { ok: true; entry: PendingEntry; body: B }
  | { ok: false; rejection: Rejection };

/** A client-side refusal (no HTTP round trip) — status 0, message shown as-is. */
function clientRejection(message: string): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: { status: 0, message } };
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
    if (e instanceof InsufficientKarma) return clientRejection('not enough karma to post right now.');
    throw e;
  }
  const body = await deps.write.submitPost(signedJson(built.tx, deps.identity, built.txId, id.pubKeyHex), content);
  if (isRejection(body)) return { ok: false, rejection: body };
  // The node echoes the id it computed over the same tx; a mismatch means the
  // encodings diverged — the class the mirror tests exist for — so the entry is
  // refused rather than tracked under an id the node does not share.
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry: PendingEntry = {
    txId: built.txId,
    kind: 'post',
    postId: body.postId, // the node's own id — authoritative, never derived here
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  };
  deps.ledger.add(entry);
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
    if (e instanceof InsufficientKarma) return clientRejection('not enough karma to like right now.');
    throw e;
  }
  const body = await deps.write.submitLike(signedJson(built.tx, deps.identity, built.txId, id.pubKeyHex));
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry: PendingEntry = {
    txId: built.txId,
    kind: 'like',
    postId: targetId, // a like has no post id of its own; its target
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  };
  deps.ledger.add(entry);
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
    if (e instanceof InsufficientKarma) return clientRejection('not enough karma to vouch right now.');
    throw e;
  }
  const body = await deps.write.submitVouch(signedJson(built.tx, deps.identity, built.txId, id.pubKeyHex));
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry: PendingEntry = {
    txId: built.txId,
    kind: 'vouch',
    postId: targetKey, // the identity vouched for
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  };
  deps.ledger.add(entry);
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
  const body = await deps.write.submitUnvouch(targetKey, signedJson(built.tx, deps.identity, built.txId, id.pubKeyHex));
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry: PendingEntry = {
    txId: built.txId,
    kind: 'unvouch',
    postId: targetKey, // the identity unvouched — its box the one input
    inputs: built.tx.inputs,
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  };
  deps.ledger.add(entry);
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
    if (e instanceof InsufficientKarma) return clientRejection('not enough karma to cover the bond right now.');
    throw e;
  }
  const body = await deps.write.submitInvite(signedJson(built.tx, deps.identity, built.txId, id.pubKeyHex));
  if (isRejection(body)) return { ok: false, rejection: body };
  if (body.txId !== built.txId) return clientRejection('the node computed a different transaction id');

  const entry: PendingEntry = {
    txId: built.txId,
    kind: 'invite',
    postId: inviteeKey, // the key invited
    inputs: built.tx.inputs,
    ...(built.change ? { change: built.change } : {}),
    expiresAtHeight: body.expiresAtHeight,
    submittedAtHeight: ctx.height,
  };
  deps.ledger.add(entry);
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

/** Serialise the unsigned tx and inject the one signature over its id — the
 *  signature is not in the txId preimage, so it is added after the id is fixed. */
function signedJson(
  tx: Parameters<typeof txToJson>[0],
  identity: Signer,
  txId: string,
  pubKeyHex: string,
): Record<string, unknown> {
  const body = txToJson(tx);
  body.signatures = { [pubKeyHex]: identity.sign(txId) };
  return body;
}
