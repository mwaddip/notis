import { describe, it, expect } from 'vitest';
import {
  computeTxId,
  decodeTx,
  encodeTx,
  profileFor,
} from '@dagsocial/types';
import type { AnyBoxCandidate, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { applyBlock, screenBody } from '@dagsocial/consensus';
import type { ApplyContext } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  candidateBlock,
  changeOf,
  claimTx,
  identityRecord,
  inviteTx,
  karmaBox,
  likeTx,
  protocolBox,
  seededIdentity,
  threadTx,
  withdrawTx,
  hex,
  type Built,
} from './helpers.js';

/**
 * `screenBody` answers which of a body's user transactions apply, each against the state the ones
 * before it leave (CONSENSUS_INTERFACE → Screening a body). Every case first asserts, as a
 * control, `applyBlock`'s verdict over the body, then asserts `screenBody`'s answer.
 */

const ctx: ApplyContext = applyContextFor(profileFor('devnet'));

const miner = seededIdentity('screen-body/miner');
const author = seededIdentity('screen-body/author');
const a = seededIdentity('screen-body/a');
const b = seededIdentity('screen-body/b');
const c = seededIdentity('screen-body/c');
const u = seededIdentity('screen-body/u');
const l = seededIdentity('screen-body/liker');
const w = seededIdentity('screen-body/withdrawer');
const i1 = seededIdentity('screen-body/invitee');
const sparse = seededIdentity('screen-body/sparse');

/** A fresh view: three roots with karma 1000; the other identities with karma 100; emission and karma pool. */
function genesis(): MemoryStateView {
  const view = new MemoryStateView({ memberCount: 3 });
  let nonce = 1;
  const root = identityRecord({ memberSinceBlock: 1 });
  for (const who of [miner, author, u]) {
    view.insertBox(karmaBox(who.userId, 1000n, nonce++, 0));
    view.putIdentityRecord(who.userId, root);
  }
  for (const who of [a, b, c, l, w]) {
    view.insertBox(karmaBox(who.userId, 100n, nonce++, 0));
    view.putIdentityRecord(who.userId, identityRecord());
  }
  // `sparse` holds a single karma box of value 1, below every post's price.
  view.insertBox(karmaBox(sparse.userId, 1n, nonce++, 0));
  view.putIdentityRecord(sparse.userId, identityRecord());
  view.insertBox(protocolBox('emission', profileFor('devnet').creditEmissionTotal, nonce++));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, nonce++));
  return view;
}

/** The largest karma box of `who` the view holds, as the builders take. */
function largest(view: MemoryStateView, who: { userId: Uint8Array }) {
  const box = view.getKarmaBoxes(who.userId)[0];
  if (!box) throw new Error('no karma');
  return box;
}

/** The reason `applyBlock` gives over this view and this body. */
function reasonFor(view: MemoryStateView, block: OrderingBlock): string {
  const result = applyBlock(view, block, ctx);
  if (result.ok) throw new Error('applyBlock accepted a body a case built to be refused');
  return result.reason;
}

/** The block with body entry `i` changed and re-encoded; the declared id, which no signature enters, stays. */
function withEntry(block: OrderingBlock, i: number, change: (tx: UtxoTransaction) => void): OrderingBlock {
  const utxoTxs = [...block.utxoTxTree.utxoTxs];
  const tx = decodeTx(utxoTxs[i]!);
  change(tx);
  utxoTxs[i] = encodeTx(tx);
  return { ...block, utxoTxTree: { ...block.utxoTxTree, utxoTxs } };
}

/** A copy of the signature with its first bit flipped. */
function flipped(signature: Uint8Array): Uint8Array {
  const out = Uint8Array.from(signature);
  out[0] = out[0]! ^ 1;
  return out;
}

describe('screenBody — which of a body\'s transactions apply', () => {
  it.fails('a stale like among honest transactions — the like alone, at its index', () => {
    const view = genesis();
    const postId = 'ab'.repeat(32);
    view.confirmPost(postId);
    view.insertBlockTopology(postId, author.userId, 1);
    view.withdrawPost(postId);
    const txs: Built[] = [
      threadTx(a, largest(view, a), 'one honest thread', 2),
      likeTx(l, largest(view, l), postId, author.userId, 2),
      threadTx(b, largest(view, b), 'another honest thread', 2),
    ];
    const block = candidateBlock(view, 2, txs, miner.userId, ctx);
    const reason = reasonFor(view, block);
    expect(reason).toContain('withdrawn or unknown post');
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 1, reason }] });
  });

  it.fails('two claims by one identity — the second alone, "identity holds a name"', () => {
    const view = genesis();
    const first = claimTx(u, largest(view, u), 'firstname', 2);
    const second = claimTx(u, changeOf(first), 'Secondname', 2);
    const block = candidateBlock(view, 2, [first, second], miner.userId, ctx);
    const reason = reasonFor(view, block);
    expect(reason).toContain('identity holds a name');
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 1, reason }] });
  });

  it.fails('a refusal takes its dependants — the chained spend refused beside the refused like', () => {
    const view = genesis();
    const postId = 'cd'.repeat(32);
    view.confirmPost(postId);
    view.insertBlockTopology(postId, author.userId, 1);
    view.withdrawPost(postId);
    const stale = likeTx(l, largest(view, l), postId, author.userId, 2);
    const chained = threadTx(l, changeOf(stale), 'a chain on the refused like\'s change', 2);
    const block = candidateBlock(view, 2, [stale, chained], miner.userId, ctx);
    const staleReason = reasonFor(view, block);
    expect(staleReason).toContain('withdrawn or unknown post');
    const screen = screenBody(view, block, ctx);
    expect(screen.refused.map((r) => r.index)).toEqual([0, 1]);
    expect(screen.refused[0]!.reason).toBe(staleReason);
    expect(screen.refused[1]!.reason).toContain('has an unresolved input');
  });

  it.fails('the passes repeat — a short-karma post and a like of it, the like refused only by a second pass', () => {
    const view = genesis();
    const bad = threadTx(sparse, largest(view, sparse), 'a post the author cannot afford', 2);
    const likeOfBad = likeTx(l, largest(view, l), bad.postId, sparse.userId, 2);
    const block = candidateBlock(view, 2, [bad, likeOfBad], miner.userId, ctx);
    const badReason = reasonFor(view, block);
    const screen = screenBody(view, block, ctx);
    expect(screen.refused.map((r) => r.index)).toEqual([0, 1]);
    expect(screen.refused[0]!.reason).toBe(badReason);
    expect(screen.refused[1]!.reason).toContain('unconfirmed post');
  });

  it.fails('a signature is judged alone — the batch names none, the screen names the one', () => {
    const view = genesis();
    const txs: Built[] = [
      threadTx(a, largest(view, a), 'first honest', 2),
      threadTx(b, largest(view, b), 'the one with the flipped signature', 2),
      threadTx(c, largest(view, c), 'last honest', 2),
    ];
    const valid = candidateBlock(view, 2, txs, miner.userId, ctx);
    const key = hex(b.userId);
    const block = withEntry(valid, 1, (tx) => { tx.signatures[key] = flipped(tx.signatures[key]!); });
    const reason = reasonFor(view, block);
    expect(reason).toBe('Rejected block height=2: a signature in the body does not verify');
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 1, reason }] });
  });

  it.fails('the withdrawal arm — two withdrawals of one post, the second alone', () => {
    const view = genesis();
    const postId = 'ef'.repeat(32);
    view.confirmPost(postId);
    view.insertBlockTopology(postId, w.userId, 1);
    const first = withdrawTx(w, largest(view, w), postId, 2);
    const second = withdrawTx(w, changeOf(first), postId, 2);
    const block = candidateBlock(view, 2, [first, second], miner.userId, ctx);
    const reason = reasonFor(view, block);
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 1, reason }] });
  });

  it.fails('one invitee per block — two bonds naming one key, the second alone', () => {
    const view = genesis();
    const first = inviteTx(author, largest(view, author), i1.userId, 25n, 2);
    const second = inviteTx(u, largest(view, u), i1.userId, 25n, 2);
    const block = candidateBlock(view, 2, [first, second], miner.userId, ctx);
    const reason = reasonFor(view, block);
    expect(reason).toContain('which another bond in this block already names');
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 1, reason }] });
  });

  it('an accepted body is refused nothing', () => {
    const view = genesis();
    const txs: Built[] = [
      threadTx(a, largest(view, a), 'a honest thread', 2),
      threadTx(b, largest(view, b), 'another honest thread', 2),
      claimTx(u, largest(view, u), 'namehere', 2),
    ];
    const block = candidateBlock(view, 2, txs, miner.userId, ctx);
    const applied = applyBlock(view, block, ctx);
    expect(applied.ok).toBe(true);
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [] });
  });

  it('the settlement is not screened — a body of valid transactions whose settlement was altered', () => {
    const view = genesis();
    const txs: Built[] = [threadTx(a, largest(view, a), 'a thread', 2)];
    const valid = candidateBlock(view, 2, txs, miner.userId, ctx);
    // Alter the settlement — its coinbase short by one base unit, re-encoded under a recomputed id.
    const lastIndex = valid.utxoTxTree.utxoTxIds.length - 1;
    const settlement = decodeTx(valid.utxoTxTree.utxoTxs[lastIndex]!);
    const coinbase = settlement.outputs.at(-1)!;
    const altered: UtxoTransaction = {
      ...settlement,
      outputs: [...settlement.outputs.slice(0, -1), { ...coinbase, value: coinbase.value - 1n } as AnyBoxCandidate],
    };
    const utxoTxs = [...valid.utxoTxTree.utxoTxs];
    utxoTxs[lastIndex] = encodeTx(altered);
    const utxoTxIds = [...valid.utxoTxTree.utxoTxIds];
    utxoTxIds[lastIndex] = computeTxId(altered);
    const block: OrderingBlock = { ...valid, utxoTxTree: { utxoTxIds, utxoTxs } };
    const applied = applyBlock(view, block, ctx);
    expect(applied.ok).toBe(false);
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [] });
  });

  it.fails('deterministic — case 1\'s body screened twice over two identical views answers the same', () => {
    const build = (): { view: MemoryStateView; block: OrderingBlock } => {
      const view = genesis();
      const postId = 'ab'.repeat(32);
      view.confirmPost(postId);
      view.insertBlockTopology(postId, author.userId, 1);
      view.withdrawPost(postId);
      const txs: Built[] = [
        threadTx(a, largest(view, a), 'one honest thread', 2),
        likeTx(l, largest(view, l), postId, author.userId, 2),
        threadTx(b, largest(view, b), 'another honest thread', 2),
      ];
      return { view, block: candidateBlock(view, 2, txs, miner.userId, ctx) };
    };
    const first = build();
    const second = build();
    const r1 = screenBody(first.view, first.block, ctx);
    const r2 = screenBody(second.view, second.block, ctx);
    expect(r1).toStrictEqual(r2);
    expect(r1.refused).toHaveLength(1);
    expect(r1.refused[0]!.index).toBe(1);
  });
});
