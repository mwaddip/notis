import { readBuildContext } from './reads';
import { buildPost, buildLike, txToJson, InsufficientKarma } from './builders';
import type { PendingLedger } from './ledger';
import type { PendingEntry } from './types';
import type { Api } from '../api/client';
import type { WriteClient, Rejection, PostSubmitResult, LikeSubmitResult } from '../api/write';
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
  reads: Pick<Api, 'karma' | 'status' | 'post'>;
  write: Pick<WriteClient, 'submitPost' | 'submitLike'>;
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
