import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sign as cryptoSign } from 'crypto';
import { MAX_BLOCK_COST, PROTOCOL_VERSION, W_SIG, computeTxId, decodeTx, encodeTx, profileFor } from '@dagsocial/types';
import type { AnyBoxCandidate, CreditBox, KarmaBox, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { verifyEd25519, verifyEd25519Batch } from '@dagsocial/validation';
import { applyBlock } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  candidateBlock,
  consolidateTx,
  finish,
  hex,
  identityRecord,
  karmaBox,
  protocolBox,
  seedProvenance,
  seededIdentity,
  threadTx,
  uid,
  type Built,
  type TestIdentity,
} from './helpers.js';

// The body check is one `verifyEd25519Batch` call and the pass makes no single
// check; the spies count both.
vi.mock('@dagsocial/validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/validation')>();
  return {
    ...actual,
    verifyEd25519: vi.fn(actual.verifyEd25519),
    verifyEd25519Batch: vi.fn(actual.verifyEd25519Batch),
  };
});

/**
 * `applyBlock` checks every signature its body carries as one batch, before any
 * transaction applies, and the pass answers each signature from what the batch
 * verified (CONSENSUS_INTERFACE → Applying a block;
 * CONSENSUS_INTERFACE → The overlay). The body: a thread, a two-signer credit
 * payment, a second thread by the first author and a third author's thread —
 * then the settlement.
 */

const ctx = applyContextFor(profileFor('devnet'));
const H = 1;
const CREDIT = 10n ** 8n;
const miner = seededIdentity('body-signatures/miner');
const author = seededIdentity('body-signatures/author');
const other = seededIdentity('body-signatures/other-author');
const payers = [seededIdentity('body-signatures/payer-1'), seededIdentity('body-signatures/payer-2')]
  .sort((x, y) => (hex(x.userId) > hex(y.userId) ? -1 : 1));
const payerHigh = payers[0]!;
const payerLow = payers[1]!;
const outsider = seededIdentity('body-signatures/outsider');
const BODY_REASON = `Rejected block height=${H}: a signature in the body does not verify`;

function genesis(): { view: MemoryStateView; first: KarmaBox; second: KarmaBox; others: KarmaBox; credits: CreditBox[] } {
  const view = new MemoryStateView({ memberCount: 0 });
  let nonce = 1;
  const first = karmaBox(author.userId, 100n, nonce++, 0);
  const second = karmaBox(author.userId, 90n, nonce++, 0);
  const others = karmaBox(other.userId, 100n, nonce++, 0);
  for (const box of [first, second, others]) view.insertBox(box);
  view.putIdentityRecord(author.userId, identityRecord());
  view.putIdentityRecord(other.userId, identityRecord());
  const credits = [payerHigh, payerLow].map((payer) => {
    const box = seedProvenance<CreditBox>(
      { boxType: 'credit', value: CREDIT, createdAtBlock: 0, owner: payer.userId },
      0,
      nonce++,
    );
    view.insertBox(box);
    return box;
  });
  view.insertBox(protocolBox('emission', profileFor('devnet').creditEmissionTotal, nonce++));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, nonce++));
  return { view, first, second, others, credits };
}

/** `who`'s signature over the transaction id. */
function signatureBy(who: TestIdentity, txId: string): Uint8Array {
  return new Uint8Array(cryptoSign(null, Buffer.from(txId, 'hex'), who.privateKey));
}

/** Both credit boxes paid to the outsider, signed by the payer whose key sorts higher first. */
function payment(credits: CreditBox[]): Built {
  const tx: UtxoTransaction = {
    inputs: credits.map((box) => box.id!),
    outputs: [{ boxType: 'credit', value: 2n * CREDIT, createdAtBlock: H, owner: outsider.userId } as AnyBoxCandidate],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  const txId = computeTxId(tx);
  for (const payer of [payerHigh, payerLow]) tx.signatures[hex(payer.userId)] = signatureBy(payer, txId);
  return finish(tx, null);
}

/** The block with body entry `i` changed and re-encoded; its declared id, which no signature enters, stays. */
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

/** Each entry of the one batch `applyBlock` made, as `[txId, key, signature]` hex. */
function batchedEntries(): string[][] {
  expect(vi.mocked(verifyEd25519Batch)).toHaveBeenCalledTimes(1);
  const [entries] = vi.mocked(verifyEd25519Batch).mock.calls[0]!;
  return entries.map((e) => [hex(e.message), hex(e.publicKey), hex(e.signature)]);
}

describe('applyBlock checks every signature the body carries as one batch', () => {
  const { view, first, second, others, credits } = genesis();
  const body = [
    threadTx(author, first, 'the first thread', H),
    payment(credits),
    threadTx(author, second, 'the second thread, by the same author', H),
    threadTx(other, others, 'the last thread', H),
  ];
  const valid = candidateBlock(view, H, body, miner.userId, ctx);

  /** `applyBlock` over the view, which it never writes, with both spies cleared first. */
  const apply = (block: OrderingBlock) => {
    vi.mocked(verifyEd25519).mockClear();
    vi.mocked(verifyEd25519Batch).mockClear();
    const before = view.digest();
    const result = applyBlock(view, block, ctx);
    expect(view.digest()).toBe(before);
    return result;
  };

  beforeEach(() => {
    vi.mocked(verifyEd25519).mockClear();
    vi.mocked(verifyEd25519Batch).mockClear();
  });

  it("one batch of every entry — in body order, each map in its decoded (ascending key) order — and no single check", () => {
    // The payment was signed in descending key order; its bytes carry the map ascending.
    expect(Object.keys(body[1]!.tx.signatures)).toEqual([hex(payerHigh.userId), hex(payerLow.userId)]);
    const expected = body.flatMap(({ tx, txId }) =>
      Object.keys(tx.signatures).sort().map((key) => [txId, key, hex(tx.signatures[key]!)]),
    );

    expect(apply(valid).ok).toBe(true);
    expect(batchedEntries()).toEqual(expected);
    expect(verifyEd25519).not.toHaveBeenCalled();
  });

  it('a bad signature in the first, a middle or the last transaction rejects the block with the body check\'s reason', () => {
    for (const [i, signer] of [[0, author], [1, payerLow], [3, other]] as const) {
      const key = hex(signer.userId);
      const bad = flipped(body[i]!.tx.signatures[key]!);
      expect(verifyEd25519(bad, Buffer.from(body[i]!.txId, 'hex'), signer.userId)).toBe(false);

      const block = withEntry(valid, i, (tx) => { tx.signatures[key] = bad; });
      expect(apply(block), `entry ${i}`).toEqual({ ok: false, reason: BODY_REASON });
      expect(batchedEntries()).toHaveLength(5);
      expect(verifyEd25519).not.toHaveBeenCalled();
    }
  });

  it('a signature its key made over another transaction of the body rejects the block the same way', () => {
    const key = hex(author.userId);
    const [early, late] = [body[0]!.tx.signatures[key]!, body[2]!.tx.signatures[key]!];
    const swapped = withEntry(withEntry(valid, 0, (tx) => { tx.signatures[key] = late; }), 2, (tx) => {
      tx.signatures[key] = early;
    });
    expect(apply(swapped)).toEqual({ ok: false, reason: BODY_REASON });
  });

  it('the batch runs before any transaction applies: an earlier transaction breaking another rule does not answer first', () => {
    const spentTwice = candidateBlock(view, H, [
      body[0]!,
      threadTx(author, first, 'the first box, spent again', H),
      body[3]!,
    ], miner.userId, ctx);
    expect(apply(spentTwice)).toEqual({ ok: false, reason: expect.stringContaining('has an unresolved input') });

    const key = hex(other.userId);
    const alsoBad = withEntry(spentTwice, 2, (tx) => { tx.signatures[key] = flipped(tx.signatures[key]!); });
    expect(apply(alsoBad)).toEqual({ ok: false, reason: BODY_REASON });
  });

  it("a missing signature is not an entry: the batch passes and the pass refuses the transaction with its own reason", () => {
    const unsigned = withEntry(valid, 2, (tx) => { tx.signatures = {}; });
    expect(apply(unsigned)).toEqual({
      ok: false,
      reason:
        `Rejected block height=${H}: embedded UTXO tx ${body[2]!.txId} failed re-validation: ` +
        `Missing or invalid owner signature for box ${second.id}`,
    });
    expect(batchedEntries().map(([txId]) => txId)).not.toContain(body[2]!.txId);
    expect(verifyEd25519).not.toHaveBeenCalled();
  });

  it('a transaction carrying more signatures than inputs is refused before the batch runs, with its own reason', () => {
    // The last thread spends one input. Its extra entry does not verify, and neither does the first
    // transaction's own signature below: a batch run first would answer the body check's reason.
    const key = hex(outsider.userId);
    const extra = flipped(signatureBy(outsider, body[3]!.txId));
    expect(verifyEd25519(extra, Buffer.from(body[3]!.txId, 'hex'), outsider.userId)).toBe(false);
    const overSigned = withEntry(valid, 3, (tx) => { tx.signatures[key] = extra; });
    const reason = `Rejected block height=${H}: embedded UTXO tx ${body[3]!.txId} carries more signatures than inputs`;

    expect(apply(overSigned)).toEqual({ ok: false, reason });
    expect(verifyEd25519Batch).not.toHaveBeenCalled();
    expect(verifyEd25519).not.toHaveBeenCalled();

    const authorKey = hex(author.userId);
    const alsoBad = withEntry(overSigned, 0, (tx) => { tx.signatures[authorKey] = flipped(tx.signatures[authorKey]!); });
    expect(apply(alsoBad)).toEqual({ ok: false, reason });
    expect(verifyEd25519Batch).not.toHaveBeenCalled();
    expect(verifyEd25519).not.toHaveBeenCalled();
  });

  it('a transaction carrying as many signatures as inputs reaches the batch: a key no input requires passes it and the pass refuses the key, or fails it', () => {
    // Two inputs and one signer, so the outsider's entry is the second of two.
    const merged = consolidateTx(author, [first, second], H);
    const block = candidateBlock(view, H, [merged], miner.userId, ctx);
    expect(apply(block).ok).toBe(true);
    const key = hex(outsider.userId);
    const spare = signatureBy(outsider, merged.txId);

    const verifying = withEntry(block, 0, (tx) => { tx.signatures[key] = spare; });
    expect(apply(verifying)).toEqual({
      ok: false,
      reason:
        `Rejected block height=${H}: embedded UTXO tx ${merged.txId} failed re-validation: ` +
        `Signature map carries unrequired key ${key.slice(0, 16)}…`,
    });
    expect(batchedEntries()).toContainEqual([merged.txId, key, hex(spare)]);

    const failing = withEntry(block, 0, (tx) => { tx.signatures[key] = flipped(spare); });
    expect(apply(failing)).toEqual({ ok: false, reason: BODY_REASON });
    expect(batchedEntries()).toHaveLength(2);
  });

  it('a body carrying no signature is an empty batch', () => {
    const empty = candidateBlock(view, H, [], miner.userId, ctx);
    expect(apply(empty).ok).toBe(true);
    expect(batchedEntries()).toEqual([]);
  });
});

/**
 * The signatures' cost, checked before the batch runs (CONSENSUS_INTERFACE →
 * Applying a block → "The signatures' cost is checked before the batch runs"):
 * a body whose entries × `W_SIG` is over `MAX_BLOCK_COST` is refused without
 * the batch, and one exactly at it reaches the batch.
 */
describe("applyBlock checks the signatures' cost before the batch", () => {
  const { view } = genesis();
  const settled = candidateBlock(view, H, [], miner.userId, ctx);
  const AT_BUDGET = MAX_BLOCK_COST / W_SIG;
  // As many signers as `MAX_TX_BYTES` holds in one transaction (CONSENSUS_INTERFACE → Cost → "A transaction
  // checks each signer once").
  const SIGNERS_PER_TX = 77;

  /**
   * A transaction whose signature map carries entries `from` to `from + signers`, over `inputs` inputs of its own
   * and one output. No entry verifies and no input resolves: nothing past the batch runs.
   */
  const bulkTx = (from: number, signers: number, inputs = signers): { txId: string; bytes: Uint8Array } => {
    const tx: UtxoTransaction = {
      inputs: [],
      outputs: [{ boxType: 'credit', value: 1n, createdAtBlock: H, owner: outsider.userId } as AnyBoxCandidate],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    for (let i = from; i < from + inputs; i++) tx.inputs.push(hex(uid(`body-signatures/bulk-input-${i}`)));
    for (let i = from; i < from + signers; i++) tx.signatures[hex(uid(`body-signatures/bulk-key-${i}`))] = new Uint8Array(64).fill(1);
    return { txId: computeTxId(tx), bytes: encodeTx(tx) };
  };

  /** Transactions carrying `total` entries between them, `SIGNERS_PER_TX` a transaction. */
  const entries = (total: number): Array<{ txId: string; bytes: Uint8Array }> => {
    const txs: Array<{ txId: string; bytes: Uint8Array }> = [];
    for (let from = 0; from < total; from += SIGNERS_PER_TX) txs.push(bulkTx(from, Math.min(SIGNERS_PER_TX, total - from)));
    return txs;
  };

  /** A block of these user transactions, then the settlement of an empty body. */
  const withBody = (txs: Array<{ txId: string; bytes: Uint8Array }>): OrderingBlock => ({
    ...settled,
    utxoTxTree: {
      utxoTxIds: [...txs.map((t) => t.txId), ...settled.utxoTxTree.utxoTxIds],
      utxoTxs: [...txs.map((t) => t.bytes), ...settled.utxoTxTree.utxoTxs],
    },
  });

  beforeEach(() => {
    vi.mocked(verifyEd25519).mockClear();
    vi.mocked(verifyEd25519Batch).mockClear();
  });

  it('the budget holds a whole number of signatures', () => {
    expect(Number.isInteger(AT_BUDGET)).toBe(true);
  });

  it('a body whose signatures cost more than the budget is refused before the batch runs, with its own reason', () => {
    expect(applyBlock(view, withBody(entries(AT_BUDGET + 1)), ctx)).toEqual({
      ok: false,
      reason: `Rejected block height=${H}: its ${AT_BUDGET + 1} signatures cost more than a block may`,
    });
    expect(verifyEd25519Batch).not.toHaveBeenCalled();
    expect(verifyEd25519).not.toHaveBeenCalled();
  });

  it('a body whose signatures cost exactly the budget reaches the batch', () => {
    // The batch's answer is stubbed: the claim is that every entry reaches it, not how it verifies them.
    vi.mocked(verifyEd25519Batch).mockReturnValueOnce(false);
    expect(applyBlock(view, withBody(entries(AT_BUDGET)), ctx)).toEqual({ ok: false, reason: BODY_REASON });
    expect(batchedEntries()).toHaveLength(AT_BUDGET);
  });

  it('a transaction carrying more signatures than inputs answers before the signatures\' cost', () => {
    const [first, ...rest] = entries(AT_BUDGET + 1);
    const overSigned = bulkTx(0, SIGNERS_PER_TX, SIGNERS_PER_TX - 1);
    expect(first!.txId).not.toBe(overSigned.txId);
    expect(applyBlock(view, withBody([overSigned, ...rest]), ctx)).toEqual({
      ok: false,
      reason: `Rejected block height=${H}: embedded UTXO tx ${overSigned.txId} carries more signatures than inputs`,
    });
    expect(verifyEd25519Batch).not.toHaveBeenCalled();
  });
});
