import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { decode } from 'cbor-x';
import {
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  computePostId,
  computeTxId,
  decodeOrderingBlock,
  encodeOrderingBlock,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, KarmaBox, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { materializeOutput } from '@dagsocial/consensus';
import {
  activateProverOverStore,
  makeApplicableBlock,
  makeKarmaBox,
  makeLikeTx,
  makePostCommit,
  makeTestIdentity,
  signTransaction,
  type TestIdentity,
} from '../helpers.js';

/**
 * The writer of a block's effects (NODE_INTERFACE → Block Journal): what it
 * journals for a body decoded from a `Buffer`, and that it swallows no failed
 * write (NODE_INTERFACE → "The funnel is total").
 */

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function outputsOf(tx: UtxoTransaction): AnyBox[] {
  const txId = computeTxId(tx);
  return tx.outputs.map((out, index) => materializeOutput(out, txId, index));
}

/** A thread paid from `input`, its change output 0. */
function threadTx(author: TestIdentity, input: AnyBox, content: string, height: number): UtxoTransaction {
  const outputs: AnyBoxCandidate[] = [];
  if (input.value > POST_PRICE_THREAD) {
    outputs.push({ boxType: 'karma', value: input.value - POST_PRICE_THREAD, createdAtBlock: height, owner: author.userId } as AnyBoxCandidate);
  }
  outputs.push({ boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: height } as AnyBoxCandidate);
  const tx: UtxoTransaction = {
    inputs: [input.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: makePostCommit(author.userId, content),
  };
  signTransaction(tx, author.privateKey, hexOf(author.userId));
  return tx;
}

/** The block as a node holds it once decoded from a `Buffer`: every byte field a `Buffer`. */
const decodedFromBuffer = (block: OrderingBlock): OrderingBlock =>
  decodeOrderingBlock(Buffer.from(encodeOrderingBlock(block)));

interface JournalView {
  mutations: Array<{ kind: string; op?: string; identityId?: Uint8Array; box?: Record<string, unknown> }>;
  likeRecordInsertions: Array<{ likerId: Uint8Array }>;
}

describe('the effects writer', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.doUnmock('../../src/store/posts.js');
    vi.resetModules();
  });

  it('journals an identity or a liker read from a box the same Buffer-decoded block created as a Uint8Array, as a store read gives it', async () => {
    const [author, poster, liker] = [makeTestIdentity(), makeTestIdentity(), makeTestIdentity()];
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
    const utxo = await import('../../src/store/utxo.js');
    const posts = await import('../../src/store/posts.js');
    for (const [who, nonce] of [[author, 1], [poster, 2], [liker, 3]] as const) {
      utxo.insertBox(makeKarmaBox(100n, who.userId, 0, nonce));
    }
    await activateProverOverStore();
    const blockApply = await import('../../src/services/block-apply.js');
    const largest = (who: TestIdentity): KarmaBox => utxo.getKarmaBoxes(who.userId)[0]!;

    // Block 1 confirms the author's thread.
    const opening = threadTx(author, largest(author), 'the thread block 2 likes', 1);
    const openingId = computePostId(computeTxId(opening), 0);
    posts.insertPost(openingId, opening.post!, 'the thread block 2 likes');
    expect(blockApply.applyOrderingBlock(await makeApplicableBlock({ height: 1, utxoTxs: [opening] }))).toBe(true);

    // Block 2: each second transaction spends the change its first created, so
    // the poster's activity bump and the liker's like record read their owner
    // off a box the block itself inserted.
    const first = threadTx(poster, largest(poster), 'a first thread', 2);
    const second = threadTx(poster, outputsOf(first)[0]!, 'a second thread, paid from the first\'s change', 2);
    const firstId = computePostId(computeTxId(first), 0);
    const likeOpening = makeLikeTx(liker, largest(liker), openingId, author.userId);
    const likeFirst = makeLikeTx(liker, outputsOf(likeOpening)[0] as KarmaBox, firstId, poster.userId);
    const built = await makeApplicableBlock({ height: 2, utxoTxs: [first, second, likeOpening, likeFirst] });
    const block = decodedFromBuffer(built);
    expect(Buffer.isBuffer(block.utxoTxTree.utxoTxs[1])).toBe(true);
    expect(blockApply.applyOrderingBlockVerdict(block)).toEqual({ applied: true });

    const stored = db.getDb()
      .prepare('SELECT journal_cbor FROM block_journal WHERE block_height = 2')
      .get() as { journal_cbor: Buffer };
    const view = decode(stored.journal_cbor) as JournalView;

    const bumps = view.mutations.filter((m) => m.kind === 'record' && hexOf(m.identityId!) === hexOf(poster.userId));
    expect(bumps.length).toBeGreaterThanOrEqual(2);
    expect(view.likeRecordInsertions).toHaveLength(2);
    // Tag 64 decodes as a Uint8Array and a bare byte string as a Buffer.
    for (const m of view.mutations.filter((m) => m.kind === 'record')) {
      expect(Buffer.isBuffer(m.identityId), hexOf(m.identityId!)).toBe(false);
    }
    for (const like of view.likeRecordInsertions) {
      expect(Buffer.isBuffer(like.likerId)).toBe(false);
    }
    // The inserted boxes are listed as the block passed them: the decoded body's own bytes.
    const inserted = view.mutations.filter((m) => m.kind === 'box' && m.op === 'insert' && m.box!['boxType'] === 'karma');
    expect(inserted.length).toBeGreaterThan(0);
    for (const m of inserted) expect(Buffer.isBuffer(m.box!['owner'])).toBe(true);
  });

  for (const failing of ['insertPost', 'confirmPost'] as const) {
    it(`a failing ${failing} fails the block as a local verdict, and writes nothing`, async () => {
      vi.doMock('../../src/store/posts.js', async () => {
        const actual = await vi.importActual<typeof import('../../src/store/posts.js')>('../../src/store/posts.js');
        return {
          ...actual,
          [failing]: () => { throw new Error(`${failing}: disk full`); },
        };
      });
      const author = makeTestIdentity();
      const db = await import('../../src/store/db.js');
      db.initDb(':memory:');
      db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
      const utxo = await import('../../src/store/utxo.js');
      const karma = makeKarmaBox(100n, author.userId, 0, 1);
      utxo.insertBox(karma);
      const handle = await activateProverOverStore();
      const preDigest = hexOf(handle.prover.digest()!);
      const blockApply = await import('../../src/services/block-apply.js');
      const ordering = await import('../../src/store/ordering.js');
      const { getBlockJournal } = await import('../../src/store/journal.js');

      // No row for the post, so the writer inserts its placeholder, then
      // confirms it: whichever of the two fails, the block does.
      const thread = threadTx(author, karma, 'a thread this node holds no packet for', 1);
      const block = await makeApplicableBlock({ utxoTxs: [thread] });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const verdict = blockApply.applyOrderingBlockVerdict(block);

      expect(verdict).toMatchObject({ applied: false, class: 'local' });
      expect((verdict as { detail?: string }).detail).toContain(`${failing}: disk full`);
      expect(ordering.getCurrentHeight()).toBe(0);
      expect(utxo.getBox(karma.id!)).not.toBeNull();
      expect(getBlockJournal(1)).toBeNull();
      expect(hexOf(handle.prover.digest()!)).toBe(preDigest);
    });
  }
});
