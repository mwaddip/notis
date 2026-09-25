import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { decode } from 'cbor-x';
import {
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  computePostId,
  computeTxId,
  decodeOrderingBlock,
  encodeOrderingBlock,
  identityRecordKey,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  IdentityRecord,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import { materializeOutput } from '@dagsocial/consensus';
import type { BlockEffects } from '@dagsocial/consensus';
import {
  activateProverOverStore,
  makeApplicableBlock,
  makeKarmaBox,
  makeLikeTx,
  makePostCommit,
  makeTestIdentity,
  seedProvenance,
  signTransaction,
  uid,
  type TestIdentity,
} from '../helpers.js';

/**
 * The writer of a block's effects (NODE_INTERFACE → Block Journal): the entry
 * each effect journals, over effects built by hand; what it journals for a body
 * decoded from a `Buffer`; and that it swallows no failed write
 * (NODE_INTERFACE → "The funnel is total").
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

const NO_RECORD: IdentityRecord = {
  lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n,
  memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
};

function effectsOf(parts: Partial<BlockEffects>): BlockEffects {
  return { mutations: [], posts: [], likeRecords: [], withdrawals: [], appliedTxs: [], ...parts };
}

/** A fresh store, its network record at 3, and the writer over it. */
async function freshWriter() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 3)').run();
  const utxo = await import('../../src/store/utxo.js');
  const records = await import('../../src/store/identity-records.js');
  const usernames = await import('../../src/store/usernames.js');
  const likes = await import('../../src/store/likes.js');
  const posts = await import('../../src/store/posts.js');
  const { writeBlockEffects } = await import('../../src/services/block-apply.js');
  return { db, utxo, records, usernames, likes, posts, writeBlockEffects };
}

describe('the effects writer — the entry each effect journals', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('a box insert journals the box as passed and a spend its id, a record among them, in the effects\' order', async () => {
    const s = await freshWriter();
    const owner = uid('writer/box-owner');
    const held = makeKarmaBox(100n, owner, 0, 1);
    const vouch = seedProvenance<VouchBox>({
      boxType: 'vouch', value: 1n, createdAtBlock: 0,
      voucherId: uid('writer/voucher'), targetId: uid('writer/target'),
    }, 1, 2);
    s.utxo.insertBox(held);
    s.utxo.insertBox(vouch);
    const first = makeKarmaBox(60n, owner, 4, 3);
    const second = makeKarmaBox(40n, owner, 4, 4);
    const who = uid('writer/record');
    const record: IdentityRecord = { ...NO_RECORD, lastActivityBlock: 4 };

    const journal = s.writeBlockEffects(effectsOf({
      mutations: [
        { kind: 'box', op: 'insert', boxId: first.id!, box: first },
        { kind: 'box', op: 'remove', boxId: held.id! },
        { kind: 'record', identityId: who, record },
        { kind: 'box', op: 'remove', boxId: vouch.id! },
        { kind: 'box', op: 'insert', boxId: second.id!, box: second },
      ],
    }), 4);

    expect(journal.mutations).toEqual([
      { kind: 'box', op: 'insert', boxId: first.id, box: first },
      { kind: 'box', op: 'remove', boxId: held.id },
      { kind: 'record', key: identityRecordKey(who), identityId: who, record },
      { kind: 'box', op: 'remove', boxId: vouch.id },
      { kind: 'box', op: 'insert', boxId: second.id, box: second },
    ]);
    expect((journal.mutations[0] as { box?: AnyBox }).box).toBe(first);
    expect(s.utxo.getBox(first.id!)).toEqual(first);
    expect(s.utxo.getBox(second.id!)).toEqual(second);
    expect(s.utxo.getBox(held.id!)).toBeNull();
    expect(s.utxo.getBox(vouch.id!)).toBeNull();
  });

  it('a spend of a box the store does not hold live throws out of the writer, and the block\'s transaction keeps nothing', async () => {
    const s = await freshWriter();
    const inserted = makeKarmaBox(10n, uid('writer/refused'), 2, 5);
    const write = s.db.getDb().transaction(() => s.writeBlockEffects(effectsOf({
      mutations: [
        { kind: 'box', op: 'insert', boxId: inserted.id!, box: inserted },
        { kind: 'box', op: 'remove', boxId: 'ab'.repeat(32) },
      ],
    }), 2));

    expect(() => write()).toThrow(s.utxo.BoxNotLiveError);
    expect(s.utxo.getBox(inserted.id!)).toBeNull();
  });

  it('a record the block creates journals no `replaced`; one it overwrites journals the row it replaced', async () => {
    const s = await freshWriter();
    const created = uid('writer/created');
    const kept = uid('writer/kept');
    const prior: IdentityRecord = { ...NO_RECORD, lastActivityBlock: 2, lastDecayBlock: 1, memberVouches: 3 };
    s.records.putIdentityRecord(kept, prior);
    const createdRecord: IdentityRecord = { ...NO_RECORD, lastActivityBlock: 6 };
    const keptRecord: IdentityRecord = { ...prior, lastActivityBlock: 6 };

    const journal = s.writeBlockEffects(effectsOf({
      mutations: [
        { kind: 'record', identityId: created, record: createdRecord },
        { kind: 'record', identityId: kept, record: keptRecord },
      ],
    }), 6);

    expect(journal.mutations).toEqual([
      { kind: 'record', key: identityRecordKey(created), identityId: created, record: createdRecord },
      { kind: 'record', key: identityRecordKey(kept), identityId: kept, record: keptRecord, replaced: prior },
    ]);
    // Absent, not undefined: the key did not exist.
    expect('replaced' in journal.mutations[0]!).toBe(false);
    expect(s.records.getIdentityRecord(created)).toEqual(createdRecord);
    expect(s.records.getIdentityRecord(kept)).toEqual(keptRecord);
  });

  it('a record written twice journals twice, the first entry\'s `replaced` the pre-block value', async () => {
    const s = await freshWriter();
    const who = uid('writer/twice');
    const preBlock: IdentityRecord = { ...NO_RECORD, lastActivityBlock: 5, lastDecayBlock: 2 };
    s.records.putIdentityRecord(who, preBlock);
    const bumped: IdentityRecord = { ...preBlock, lastActivityBlock: 40 };
    const decayed: IdentityRecord = { ...bumped, lastDecayBlock: 40 };

    const journal = s.writeBlockEffects(effectsOf({
      mutations: [
        { kind: 'record', identityId: who, record: bumped },
        { kind: 'record', identityId: who, record: decayed },
      ],
    }), 40);

    const key = identityRecordKey(who);
    expect(journal.mutations).toEqual([
      { kind: 'record', key, identityId: who, record: bumped, replaced: preBlock },
      { kind: 'record', key, identityId: who, record: decayed, replaced: bumped },
    ]);
    expect(s.records.getIdentityRecord(who)).toEqual(decayed);
  });

  it('the network record journals the count written and the row it replaced', async () => {
    const s = await freshWriter();
    const journal = s.writeBlockEffects(effectsOf({
      mutations: [
        { kind: 'network', record: { memberCount: 4 } },
        { kind: 'network', record: { memberCount: 5 } },
      ],
    }), 7);

    expect(journal.mutations).toEqual([
      { kind: 'network', memberCount: 4, replaced: { memberCount: 3 } },
      { kind: 'network', memberCount: 5, replaced: { memberCount: 4 } },
    ]);
    expect(s.records.getNetworkRecord()).toEqual({ memberCount: 5 });
  });

  it('a claim journals the name and holder records with no `replaced`; a burn journals both removals with the rows they replaced', async () => {
    const s = await freshWriter();
    const owner = uid('writer/name-owner');
    const row = { nameLower: 'alpha', name: 'Alpha', owner: hexOf(owner), boxId: 'cd'.repeat(32), claimedAtBlock: 3 };
    const holder = { claimAvailable: false, boxId: row.boxId };

    const claim = s.writeBlockEffects(effectsOf({
      mutations: [
        { kind: 'username', nameLower: 'alpha', row, heldBefore: false },
        { kind: 'holder', owner, record: holder, heldBefore: false },
      ],
    }), 3);
    expect(claim.mutations).toEqual([
      { kind: 'username', nameLower: 'alpha', row },
      { kind: 'holder', owner, record: holder },
    ]);
    expect(claim.mutations.every((m) => !('replaced' in m))).toBe(true);
    expect(s.usernames.getUsername('alpha')).toEqual(row);

    const burn = s.writeBlockEffects(effectsOf({
      mutations: [
        { kind: 'username', nameLower: 'alpha', row: null, heldBefore: true },
        { kind: 'holder', owner, record: null, heldBefore: true },
      ],
    }), 4);
    expect(burn.mutations).toEqual([
      { kind: 'username', nameLower: 'alpha', row: null, replaced: row },
      { kind: 'holder', owner, record: null, replaced: holder },
    ]);
    expect(s.usernames.getUsername('alpha')).toBeNull();
  });

  it('each like record journals its insertion, in order, and none reaches `mutations`', async () => {
    const s = await freshWriter();
    const [a, b] = [uid('writer/liker-a'), uid('writer/liker-b')];

    const journal = s.writeBlockEffects(effectsOf({
      likeRecords: [{ targetPostId: 'post-1', likerId: a }, { targetPostId: 'post-2', likerId: b }],
    }), 9);

    expect(journal.likeRecordInsertions).toEqual([
      { targetPostId: 'post-1', likerId: a },
      { targetPostId: 'post-2', likerId: b },
    ]);
    // A like record is node-local state, never a committed entity.
    expect(journal.mutations).toEqual([]);
    expect(s.likes.hasLikeRecord('post-1', a)).toBe(true);
    expect(s.likes.hasLikeRecord('post-2', b)).toBe(true);
  });

  it('a withdrawal journals the content the store held: a full post\'s text, a placeholder\'s null', async () => {
    const s = await freshWriter();
    const author = uid('writer/withdrawer');
    const [full, placeholder] = ['e1'.repeat(32), 'e2'.repeat(32)];
    s.posts.insertPost(full, makePostCommit(author, 'a body this node holds'), 'a body this node holds');
    s.posts.insertPost(placeholder, makePostCommit(author, 'a body this node lacks'), null);

    const journal = s.writeBlockEffects(effectsOf({ withdrawals: [full, placeholder] }), 5);

    expect(journal.withdrawnPosts).toEqual([
      { id: full, content: 'a body this node holds' },
      { id: placeholder, content: null },
    ]);
    expect(s.posts.getPost(full)!.content).toBeNull();
    expect(() => s.writeBlockEffects(effectsOf({ withdrawals: ['e3'.repeat(32)] }), 6)).toThrow(/has no row/);
  });

  it('the journal carries the block\'s height, its posts\' ids and its applied transactions, and no other key', async () => {
    const s = await freshWriter();
    const author = uid('writer/poster');
    const [held, lacked] = ['f1'.repeat(32), 'f2'.repeat(32)];
    const heldCommit = makePostCommit(author, 'a post this node holds');
    const lackedCommit = makePostCommit(author, 'a post this node lacks');
    s.posts.insertPost(held, heldCommit, 'a post this node holds');
    const applied = [{ txId: 'a0'.repeat(32), txBytes: Uint8Array.of(1, 2, 3) }];

    const journal = s.writeBlockEffects(effectsOf({
      posts: [
        { postId: held, txId: 'b1'.repeat(32), post: heldCommit },
        { postId: lacked, txId: 'b2'.repeat(32), post: lackedCommit },
      ],
      appliedTxs: applied,
    }), 8);

    expect(journal.blockHeight).toBe(8);
    expect(journal.confirmedPostIds).toEqual([held, lacked]);
    expect(journal.appliedUtxoTxs).toEqual(applied);
    // The journal carries no vouch side-record: an unvouched stake waits in an
    // escrow box, journalled as a box (NODE_INTERFACE → Block Journal).
    expect(Object.keys(journal).sort()).toEqual([
      'appliedUtxoTxs', 'blockHeight', 'confirmedPostIds', 'likeRecordInsertions', 'mutations', 'withdrawnPosts',
    ]);
    // Each post confirmed at its committed index; the one this node lacked is a placeholder.
    expect(s.posts.getPost(held)).toMatchObject({ content: 'a post this node holds', blockHeight: 8, blockIndex: 0 });
    expect(s.posts.getPost(lacked)).toMatchObject({ content: null, blockHeight: 8, blockIndex: 1 });
  });
});
