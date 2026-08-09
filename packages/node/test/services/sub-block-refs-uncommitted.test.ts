import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computePostId, encodePost } from '@dagsocial/types';
import type { OrderingBlock, Post } from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { BlockJournal } from '../../src/store/journal.js';
import { hex, makeApplicableBlock, makePost, makeTestIdentity } from '../helpers.js';

// ---------------------------------------------------------------------------
// `subBlockRefs` is uncommitted — every consumer must read `subBlockEntries`
// ---------------------------------------------------------------------------
//
// `computeSubBlockRoot` builds its leaves from `subBlockEntries` and
// `pruneEntries`; it never reads `subBlockRefs`. The verifier checks that the
// refs are an array whose *length* matches the entries, and nothing else. So a
// block whose refs name entirely different post ids carries an unchanged
// `subBlockRoot`, an unchanged `blockHash`, a still-valid PoW solution and a
// still-valid validator signature — it is accepted.
//
// The defect that made that matter was an asymmetry: apply *confirmed* from the
// committed `subBlockEntries` while the journal — replayed on reorg — recorded
// the uncommitted `subBlockRefs`. Three state effects, across two sinks:
//
//   - `removeSubBlockEntries(refs)` → `DELETE FROM mempool WHERE entry_type =
//     'subblock' AND subblock_id IN (…)`, committed with the accepted block. An
//     eviction primitive: unconfirmed sub-blocks dropped network-wide without
//     ever being confirmed.
//   - `recordConfirmedSubBlocks(refs)` → the journal's `confirmedSubBlockIds`,
//     which has *two* readers, not one. `revertBlock` replays it as
//     `unconfirmPost(id)` (`fork-resolution.ts:214`) — un-confirming ids the
//     forward pass never confirmed and leaving the ones it did — and `reorg`
//     phase 2 replays it as `insertMempoolSubBlock(id, …)` (`:335`), an
//     injection primitive that *writes* attacker-chosen ids into the mempool,
//     needing no pooled victim entry the way eviction did.
//
// Only the first two are asserted below. The injection path shares its input
// with the un-confirm path — the same journal array, asserted whole with
// `toEqual` — so closing it is the same closure, but it is a distinct effect
// and naming it here is what keeps it from going missing again.
//
// These fixtures are only writable while the field exists. Phase 3b deletes it;
// until then this is the demonstration that the defect is closed.

const EXPIRY = 1000;

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (post: Post, rawCbor: Uint8Array) => void;
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertSubBlock: (
      postId: string,
      expiresAtHeight: number,
      batchId?: string | null,
    ) => number;
  };
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
  };
}

async function importForkResolution() {
  return (await import('../../src/services/fork-resolution.js')) as unknown as {
    revertBlock: (height: number) => unknown;
  };
}

/** Sub-block ids sitting in the mempool, in insertion order. */
function pooledSubBlockIds(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT subblock_id FROM mempool WHERE entry_type = 'subblock' ORDER BY rowid`,
    )
    .all()
    .map((r) => (r as { subblock_id: string }).subblock_id);
}

/** DAG status of one post — 'confirmed', 'pending', or null if absent. */
function postStatus(db: Database.Database, postId: string): string | null {
  const row = db
    .prepare(`SELECT status FROM dag_posts WHERE id = ?`)
    .get(postId) as { status: string } | undefined;
  return row?.status ?? null;
}

/**
 * A block that confirms `entryPost` while its `subBlockRefs` name `refPost`.
 *
 * The poison is applied *after* `makeApplicableBlock` has sealed the header,
 * and that is the point: `subBlockRoot`, `powNonce` and `validatorSignature`
 * all cover the entries and none of them cover the refs, so overwriting the
 * field afterwards leaves a block that is still, by every committed measure,
 * the same block. Lengths match, so the verifier's alignment check passes too.
 */
async function makePoisonedBlock(
  entryPost: { postId: string; authorHex: string },
  refPostId: string,
): Promise<OrderingBlock> {
  const block = await makeApplicableBlock({
    subBlockEntries: [
      { postId: entryPost.postId, parentRefs: [], author: entryPost.authorHex },
    ],
  });
  block.subBlockTree.subBlockRefs = [refPostId];
  return block;
}

describe('subBlockRefs is uncommitted — consumers derive from subBlockEntries', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('leaves the mempool entry the poisoned refs name, and evicts the one the entries commit to', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const handle = db.getDb();

    const author = makeTestIdentity();
    const victim = makeTestIdentity();

    // `confirmed` is the post the block actually commits to. `evictee` is the
    // unrelated post the attacker names in the refs — someone else's
    // unconfirmed sub-block, sitting in every node's mempool.
    const confirmed = makePost(author.userId, 'the block commits to this');
    const confirmedId = computePostId(confirmed);
    const evictee = makePost(victim.userId, 'an unrelated pending sub-block');
    const eviceeId = computePostId(evictee);
    expect(eviceeId).not.toBe(confirmedId);

    const posts = await importPosts();
    posts.insertPost(confirmed, encodePost(confirmed));
    posts.insertPost(evictee, encodePost(evictee));

    const mempool = await importMempool();
    mempool.insertSubBlock(confirmedId, EXPIRY);
    mempool.insertSubBlock(eviceeId, EXPIRY);
    expect(pooledSubBlockIds(handle)).toEqual([confirmedId, eviceeId]);

    const block = await makePoisonedBlock(
      { postId: confirmedId, authorHex: hex(author.userId) },
      eviceeId,
    );

    // Accepted. Nothing about the poison is visible to any committed check —
    // which is the defect being demonstrated, not an accident of the fixture.
    // Should a later phase pull the refs under `subBlockRoot`, this flips to
    // `false` and the flip is the signal, not a fixture to repair.
    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    // The eviction primitive is closed: the DELETE ran on the committed id, so
    // the victim's entry is untouched and still pending. Reading the refs would
    // have deleted `eviceeId` and left `confirmedId` in the pool forever —
    // exactly inverted from this.
    expect(pooledSubBlockIds(handle)).toEqual([eviceeId]);
  });

  it('journals the ids the entries commit to, so revert un-confirms what apply confirmed', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const handle = db.getDb();

    const author = makeTestIdentity();
    const victim = makeTestIdentity();

    const confirmed = makePost(author.userId, 'the block commits to this');
    const confirmedId = computePostId(confirmed);
    const unrelated = makePost(victim.userId, 'never named by any entry');
    const unrelatedId = computePostId(unrelated);

    const posts = await importPosts();
    posts.insertPost(confirmed, encodePost(confirmed));
    posts.insertPost(unrelated, encodePost(unrelated));

    const block = await makePoisonedBlock(
      { postId: confirmedId, authorHex: hex(author.userId) },
      unrelatedId,
    );

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    // Forward pass: the entries loop confirmed exactly one post.
    expect(postStatus(handle, confirmedId)).toBe('confirmed');
    expect(postStatus(handle, unrelatedId)).toBe('pending');

    // The journal records that same list — not the refs. `toEqual` on the whole
    // array rather than `toContain`: the failure this guards against is an
    // *extra* attacker-chosen id as much as a missing one.
    const journalStore = await importJournalStore();
    const journal = journalStore.getBlockJournal(1);
    expect(journal).not.toBeNull();
    expect(journal!.confirmedSubBlockIds).toEqual([confirmedId]);
    expect(journal!.confirmedSubBlockIds).not.toContain(unrelatedId);

    // And the round trip closes. `revertBlock` is what a reorg replays, so this
    // is the inverse under test, not a stand-in for it: after it runs, nothing
    // the block confirmed is still confirmed. Journalling the refs instead left
    // `confirmedId` permanently 'confirmed' at a height whose block no longer
    // exists, while un-confirming a post the block never touched.
    const fork = await importForkResolution();
    fork.revertBlock(1);
    expect(postStatus(handle, confirmedId)).toBe('pending');
    expect(postStatus(handle, unrelatedId)).toBe('pending');
  });
});
