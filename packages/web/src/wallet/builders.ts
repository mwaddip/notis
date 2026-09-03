import {
  computeContentHash,
  computeTxId,
  computeCandidateBoxId,
  selectBoxes,
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  REPLY_AUTHOR_SHARE,
  LIKE_KARMA_COST,
} from '@dagsocial/types';
import type {
  AnyBoxCandidate,
  CandidateOf,
  KarmaBox,
  KarmaPriceBox,
  LikeAccrualBox,
  PostCommit,
  UtxoTransaction,
} from '@dagsocial/types';
import type { SpendableBox, ChangeRef } from './types';

// The pure builders — WEB_INTERFACE → The wallet. Each takes the spendable view,
// the `/status` height and era, and parameters, and returns an unsigned
// UtxoTransaction whose shape is what `validateTx` demands. The encoding under it
// is @dagsocial/types, the shared implementation, so no mirror test is owed —
// but the builders are pinned to the demo UI's frozen vectors, a second
// implementation, in builders.test.ts.
//
// Builders exist for a post and a like, and nothing else (WEB_INTERFACE → The
// wallet). A root post: change and a `karma_price` of POST_PRICE_THREAD. A reply:
// change, a `karma_price` of POST_PRICE_REPLY − REPLY_AUTHOR_SHARE, and a
// `like_accrual` of REPLY_AUTHOR_SHARE to the parent's confirmedAuthor. A like:
// change and a `like_accrual` of LIKE_KARMA_COST to the target's confirmedAuthor.

/** Not enough karma for the price — a typed refusal the composer maps to its
 *  copy, so it never sees selectBoxes' bare throw (WEB_INTERFACE → "Affordability
 *  is known before the attempt"). */
export class InsufficientKarma extends Error {
  constructor(
    readonly required: bigint,
    readonly available: bigint,
  ) {
    super(`not enough karma: ${required} required, ${available} available`);
    this.name = 'InsufficientKarma';
  }
}

/** The reads a builder is fed — the spendable view, the height every output
 *  declares, the era to sign, and the author's own key. */
export interface BuildContext {
  spendable: SpendableBox[];
  height: number;
  era: number;
  author: string; // own pubKeyHex
}

/** An unsigned transaction, its id, and the change box the ledger predicts. */
export interface BuiltTx {
  tx: UtxoTransaction;
  txId: string;
  change: ChangeRef | null;
}

/** A parent for a reply: its id and the confirmedAuthor the share accrues to —
 *  never the row's `author`, which is a claim rather than the topology
 *  (WEB_INTERFACE → The wallet). */
export interface ReplyParent {
  id: string;
  authorHex: string;
}

/** Build a root post or a reply. A parent makes it a reply. */
export function buildPost(ctx: BuildContext, content: string, parent?: ReplyParent): BuiltTx {
  const price = parent ? POST_PRICE_REPLY : POST_PRICE_THREAD;
  const { selected, change } = selectForPrice(ctx.spendable, price);

  const outputs: AnyBoxCandidate[] = [];
  const changeBox = changeBoxOf(change, ctx);
  if (changeBox) outputs.push(changeBox);

  if (parent) {
    // A reply pays POST_PRICE_REPLY − REPLY_AUTHOR_SHARE into the pool and
    // REPLY_AUTHOR_SHARE into a marker for the parent's author.
    outputs.push(priceBox(POST_PRICE_REPLY - REPLY_AUTHOR_SHARE, ctx.height));
    outputs.push(accrualBox(REPLY_AUTHOR_SHARE, parent.authorHex, ctx.height));
  } else {
    outputs.push(priceBox(POST_PRICE_THREAD, ctx.height));
  }

  const post: PostCommit = {
    contentHash: computeContentHash(content),
    author: hexToBytes(ctx.author),
    parentRefs: parent ? [parent.id] : [],
    protocolVersion: ctx.era,
    type: 'regular',
  };

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: ctx.era,
    post,
  };
  return finish(tx, changeBox, change, ctx.height);
}

/** Build a like: karma in, change out, one marker of LIKE_KARMA_COST to the
 *  target's confirmedAuthor, `likeTarget` set. The node demands exactly one
 *  signature; this builder adds no output that would need a second. */
export function buildLike(ctx: BuildContext, targetId: string, targetAuthorHex: string): BuiltTx {
  const { selected, change } = selectForPrice(ctx.spendable, LIKE_KARMA_COST);

  const outputs: AnyBoxCandidate[] = [accrualBox(LIKE_KARMA_COST, targetAuthorHex, ctx.height)];
  const changeBox = changeBoxOf(change, ctx);
  // Change leads at index 0, as it does on a post — the demo UI's buildLikeTx
  // unshifts it, and the ledger predicts index 0.
  if (changeBox) outputs.unshift(changeBox);

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: ctx.era,
    likeTarget: targetId,
  };
  return finish(tx, changeBox, change, ctx.height);
}

/**
 * Render a signed transaction for the node's JSON edge — the inverse of its
 * `jsonToTx` (WEB_INTERFACE → Writes). Values cross as decimal strings, binary
 * fields as hex, converted by the value's type rather than a hand-kept field
 * list. A `post` and a `likeTarget` are carried when present, because both sit
 * inside the signed bytes.
 */
export function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  const body: Record<string, unknown> = {
    inputs: tx.inputs,
    outputs: tx.outputs.map(boxToJson),
    signatures: Object.fromEntries(Object.entries(tx.signatures).map(([k, v]) => [k, toHex(v)])),
    protocolVersion: tx.protocolVersion,
  };
  if (tx.likeTarget !== undefined) body.likeTarget = tx.likeTarget;
  if (tx.post !== undefined) body.post = postToJson(tx.post);
  return body;
}

// ---------------------------------------------------------------------------

function selectForPrice(
  spendable: SpendableBox[],
  price: bigint,
): { selected: SpendableBox[]; change: bigint } {
  // selectBoxes assumes value-descending order and throws a bare Error when
  // short; sort first, then refuse an unaffordable price as a typed error before
  // the throw can happen (WEB_INTERFACE → The wallet).
  const sorted = [...spendable].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const total = sorted.reduce((sum, b) => sum + b.value, 0n);
  if (total < price) throw new InsufficientKarma(price, total);
  const selected = selectBoxes(sorted, price);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  return { selected, change: selectedTotal - price };
}

/** A change box, or null when the change is zero — a zero change is no box
 *  (WEB_INTERFACE → The wallet). */
function changeBoxOf(change: bigint, ctx: BuildContext): CandidateOf<KarmaBox> | null {
  if (change <= 0n) return null;
  return { boxType: 'karma', value: change, createdAtBlock: ctx.height, owner: hexToBytes(ctx.author) };
}

function priceBox(value: bigint, height: number): CandidateOf<KarmaPriceBox> {
  return { boxType: 'karma_price', value, createdAtBlock: height };
}

function accrualBox(value: bigint, authorHex: string, height: number): CandidateOf<LikeAccrualBox> {
  return { boxType: 'like_accrual', value, createdAtBlock: height, author: hexToBytes(authorHex) };
}

function finish(
  tx: UtxoTransaction,
  changeBox: CandidateOf<KarmaBox> | null,
  change: bigint,
  height: number,
): BuiltTx {
  const txId = computeTxId(tx);
  // The change box sits at index 0 when present, so its id is
  // computeCandidateBoxId(change, txId, 0) — exact because ids are
  // provenance-derived (WEB_INTERFACE → The wallet).
  const changeRef: ChangeRef | null = changeBox
    ? { boxId: computeCandidateBoxId(changeBox, txId, 0), value: change, createdAtBlock: height }
    : null;
  return { tx, txId, change: changeRef };
}

function boxToJson(box: AnyBoxCandidate): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(box).map(([k, v]) => [
      k,
      v instanceof Uint8Array ? toHex(v) : typeof v === 'bigint' ? v.toString() : v,
    ]),
  );
}

function postToJson(commit: PostCommit): Record<string, unknown> {
  return {
    contentHash: toHex(commit.contentHash),
    author: toHex(commit.author),
    parentRefs: commit.parentRefs,
    protocolVersion: commit.protocolVersion,
    type: commit.type,
  };
}

// Hex without a Node `Buffer`: the client holds no Node global.
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
