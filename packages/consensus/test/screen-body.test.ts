import { describe, it, expect, vi } from 'vitest';
import { sign as cryptoSign } from 'crypto';
import {
  PROTOCOL_VERSION,
  computeTxId,
  decodeTx,
  encodeTx,
  profileFor,
} from '@dagsocial/types';
import type { AnyBoxCandidate, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { applyBlock, screenBody } from '@dagsocial/consensus';
import type { ApplyContext, SignatureChecks } from '@dagsocial/consensus';
import type { Ed25519BatchEntry } from '@dagsocial/validation';
import {
  MemoryStateView,
  applyContextFor,
  candidateBlock,
  changeOf,
  claimTx,
  finish,
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
  type TestIdentity,
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

/** `who`'s signature over the transaction id. */
function signatureBy(who: TestIdentity, txId: string): Uint8Array {
  return new Uint8Array(cryptoSign(null, Buffer.from(txId, 'hex'), who.privateKey));
}

describe('screenBody — which of a body\'s transactions apply', () => {
  it('a stale like among honest transactions — the like alone, at its index', () => {
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

  it('two claims by one identity — the second alone, "identity holds a name"', () => {
    const view = genesis();
    const first = claimTx(u, largest(view, u), 'firstname', 2);
    const second = claimTx(u, changeOf(first), 'Secondname', 2);
    const block = candidateBlock(view, 2, [first, second], miner.userId, ctx);
    const reason = reasonFor(view, block);
    expect(reason).toContain('identity holds a name');
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 1, reason }] });
  });

  it('a refusal takes its dependants — the chained spend refused beside the refused like', () => {
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

  it('the passes repeat — a short-karma post and a like of it, the like refused only by a second pass', () => {
    const view = genesis();
    const bad = threadTx(sparse, largest(view, sparse), 'a post the author cannot afford', 2);
    const likeOfBad = likeTx(l, largest(view, l), bad.postId, sparse.userId, 2);
    const block = candidateBlock(view, 2, [bad, likeOfBad], miner.userId, ctx);
    const badReason = reasonFor(view, block);
    const screen = screenBody(view, block, ctx);
    expect(screen.refused.map((r) => r.index)).toEqual([0, 1]);
    expect(screen.refused[0]!.reason).toBe(badReason);
    expect(screen.refused[1]!.reason).toContain('is not confirmed, so it names no author');
  });

  it('a signature is judged alone — the batch names none, the screen names the one', () => {
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

  const withChecks = (
    verify: (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) => boolean,
    verifyBatch: (entries: ReadonlyArray<Ed25519BatchEntry>) => boolean = () => true,
  ): ApplyContext => ({ ...ctx, signatureChecks: { verify, verifyBatch } });

  it("the context's `verify` is called once per entry of each screened transaction, with (signature, transaction id bytes, key)", () => {
    const view = genesis();
    const txs: Built[] = [
      threadTx(a, largest(view, a), 'first honest', 2),
      threadTx(b, largest(view, b), 'second honest', 2),
      threadTx(c, largest(view, c), 'third honest', 2),
    ];
    const block = candidateBlock(view, 2, txs, miner.userId, ctx);
    const verify = vi.fn<[Uint8Array, Uint8Array, Uint8Array], boolean>(() => true);
    const screen = screenBody(view, block, withChecks(verify));
    // Control: the honest body is refused nothing.
    expect(screen).toStrictEqual({ refused: [] });
    const expected = txs.map(({ tx, txId }) => {
      const pair = Object.entries(tx.signatures)[0]!;
      const [keyHex, signature] = pair;
      return [hex(signature), txId, keyHex];
    });
    // Last: each call carries the entry's signature, its transaction id's 32 bytes and its key —
    // one call per entry of each screened transaction, in body order.
    expect(
      verify.mock.calls.map((call) => [hex(call[0]!), hex(call[1]!), hex(call[2]!)]),
    ).toEqual(expected);
  });

  it("a `verify` answering false for one transaction's key refuses that transaction alone at its index with the body check's reason", () => {
    const view = genesis();
    const txs: Built[] = [
      threadTx(a, largest(view, a), 'first honest', 2),
      threadTx(b, largest(view, b), 'the one whose key answers false', 2),
      threadTx(c, largest(view, c), 'last honest', 2),
    ];
    const block = candidateBlock(view, 2, txs, miner.userId, ctx);
    const bKey = hex(b.userId);
    const verify = vi.fn<[Uint8Array, Uint8Array, Uint8Array], boolean>(
      (_sig, _msg, key) => hex(key) !== bKey,
    );
    // Control: the honest body is refused nothing under `ctx`.
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [] });
    const reason = `Rejected block height=2: a signature in the body does not verify`;
    // Last: the second transaction is refused alone at index 1 with the body check's reason.
    expect(screenBody(view, block, withChecks(verify))).toStrictEqual({
      refused: [{ index: 1, reason }],
    });
  });

  it("a `verify` answering true lets a flipped-signature body be refused nothing", () => {
    const view = genesis();
    const txs: Built[] = [
      threadTx(a, largest(view, a), 'first honest', 2),
      threadTx(b, largest(view, b), 'the one with the flipped signature', 2),
      threadTx(c, largest(view, c), 'last honest', 2),
    ];
    const valid = candidateBlock(view, 2, txs, miner.userId, ctx);
    const key = hex(b.userId);
    const block = withEntry(valid, 1, (tx) => { tx.signatures[key] = flipped(tx.signatures[key]!); });
    // Control: under `ctx` the flipped-signature body is refused at index 1.
    const reason = `Rejected block height=2: a signature in the body does not verify`;
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 1, reason }] });
    const verify = vi.fn<[Uint8Array, Uint8Array, Uint8Array], boolean>(() => true);
    // Last: a `verify` answering true leaves the flipped-signature body refused nothing.
    expect(screenBody(view, block, withChecks(verify))).toStrictEqual({ refused: [] });
  });

  it("the context's `verify` is called on the object: a class whose method reads `this` applies", () => {
    class ClassChecks implements SignatureChecks {
      readonly received: Uint8Array[] = [];
      verify(_sig: Uint8Array, _msg: Uint8Array, key: Uint8Array): boolean {
        this.received.push(key);
        return true;
      }
      verifyBatch(_entries: ReadonlyArray<Ed25519BatchEntry>): boolean {
        return true;
      }
    }
    const view = genesis();
    const txs: Built[] = [
      threadTx(a, largest(view, a), 'first honest', 2),
      threadTx(b, largest(view, b), 'second honest', 2),
      threadTx(c, largest(view, c), 'third honest', 2),
    ];
    const block = candidateBlock(view, 2, txs, miner.userId, ctx);
    const checks = new ClassChecks();
    // Control: a fresh class instance has recorded nothing.
    expect(checks.received).toEqual([]);
    const screen = screenBody(view, block, { ...ctx, signatureChecks: checks });
    expect(screen).toStrictEqual({ refused: [] });
    // Last: the class recorded one call per screened entry, each with its signer's key.
    expect(checks.received.map((k) => hex(k))).toEqual([hex(a.userId), hex(b.userId), hex(c.userId)]);
  });

  it('the withdrawal arm — two withdrawals of one post, the second alone', () => {
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

  it('one invitee per block — two bonds naming one key, the second alone', () => {
    const view = genesis();
    const first = inviteTx(author, largest(view, author), i1.userId, 25n, 2);
    const second = inviteTx(u, largest(view, u), i1.userId, 25n, 2);
    const block = candidateBlock(view, 2, [first, second], miner.userId, ctx);
    const reason = reasonFor(view, block);
    expect(reason).toContain('which another bond in this block already names');
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 1, reason }] });
  });

  it('a refused withdrawal leaves its post withdrawable — the first alone, the second applies', () => {
    const view = genesis();
    const postId = '12'.repeat(32);
    view.confirmPost(postId);
    view.insertBlockTopology(postId, a.userId, 1);
    // The first withdrawal spends an input no live box carries, so
    // `applyQueuedTx` refuses it at the unresolved-input gate; its own
    // withdrawal arm must not run, or the post is marked withdrawn and the
    // valid second withdrawal is refused as already-withdrawn.
    const unresolved = '00'.repeat(32);
    const first: Built = finish(
      {
        inputs: [unresolved],
        outputs: [{ boxType: 'karma', value: 100n, createdAtBlock: 2, owner: a.userId } as AnyBoxCandidate],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        postWithdraw: { postId },
      },
      a,
    );
    const second = withdrawTx(a, largest(view, a), postId, 2);
    const block = candidateBlock(view, 2, [first, second], miner.userId, ctx);
    const reason = reasonFor(view, block);
    expect(reason).toContain(`has an unresolved input ${unresolved}`);
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 0, reason }] });
  });

  it('an over-signed transaction is refused alone — the second key signs, every entry verifies', () => {
    const view = genesis();
    const input = largest(view, a);
    const tx: UtxoTransaction = {
      inputs: [input.id!],
      outputs: [{ boxType: 'karma', value: input.value, createdAtBlock: 2, owner: a.userId } as AnyBoxCandidate],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    // Signatures do not enter the id, so both are over the same `txId`.
    const txId = computeTxId(tx);
    tx.signatures[hex(a.userId)] = signatureBy(a, txId);
    tx.signatures[hex(b.userId)] = signatureBy(b, txId);
    const over = finish(tx, null);
    const block = candidateBlock(view, 2, [over], miner.userId, ctx);
    const reason = reasonFor(view, block);
    expect(reason).toBe(
      `Rejected block height=2: embedded UTXO tx ${over.txId} carries more signatures than inputs`,
    );
    expect(screenBody(view, block, ctx)).toStrictEqual({ refused: [{ index: 0, reason }] });
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

  it('deterministic — the stale-like body screened twice over two identical views answers the same', () => {
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
