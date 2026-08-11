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
// The block commits two arrays, and `subBlockRefs` is not one of them
// (TYPES_INTERFACE → "Layout — Block"). `computeSubBlockRoot` builds its leaves
// from `subBlockEntries` and `pruneEntries`, and `verifyOrderingBlockStructure`
// carries no companion refs check at all. Where the name survives it is
// derived: the HTTP DTOs in `routes/blocks.ts` and `routes/mining.ts` build it
// with `subBlockIdsOf(subBlockTree)`.
//
// What this file pins is the behavioural half, which is independent of any
// field: **apply must evict and journal the ids the block COMMITS to.** Three
// state effects, across two sinks:
//
//   - `removeSubBlockEntries` → `DELETE FROM mempool WHERE entry_type =
//     'subblock' AND subblock_id IN (…)`, committed with the accepted block. An
//     eviction primitive: unconfirmed sub-blocks dropped network-wide without
//     ever being confirmed.
//   - `recordConfirmedSubBlocks` → the journal's `confirmedSubBlockIds`,
//     which has *two* readers, not one. `revertBlock` replays it as
//     `unconfirmPost` — un-confirming ids the forward pass never confirmed and
//     leaving the ones it did — and `reorg` phase 2 replays it as
//     `insertMempoolSubBlock`, an injection primitive that *writes* ids into
//     the mempool, needing no pooled victim entry the way eviction does.
//
// Only the first two are asserted below. The injection path shares its input
// with the un-confirm path — the same journal array, asserted whole with
// `toEqual` — so closing it is the same closure, but it is a distinct effect
// and naming it here is what keeps it from going missing again.
//
// The fixtures keep a second, uncommitted post — the eviction bystander and the
// un-confirm bystander — so a regression that widened either sink beyond
// `subBlockEntries` still fails here. That a disagreeing refs list is
// **unrepresentable** rather than merely rejected is pinned where it belongs,
// in `@dagsocial/types` (`serialization.test.ts` → "the field is
// unrepresentable, not merely unwritten").

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
 * A block that commits to exactly one post.
 *
 * There is nowhere to put a poison: with one committed list, a block whose refs
 * disagree with its entries is unrepresentable rather than merely rejected. The
 * second post survives in the callers as an uncommitted bystander rather than
 * an attacker-named target — it is in the mempool and the DAG, it is not in
 * this block's entries, and every assertion below says it must be left alone.
 * That still fails if a consumer widens beyond `subBlockEntries`; what it
 * cannot do is let an attacker pick which bystander.
 */
async function makeCommittingBlock(
  entryPost: { postId: string; authorHex: string },
): Promise<OrderingBlock> {
  return makeApplicableBlock({
    subBlockEntries: [
      { postId: entryPost.postId, parentRefs: [], author: entryPost.authorHex },
    ],
  });
}

describe('subBlockRefs is uncommitted — consumers derive from subBlockEntries', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('evicts only the mempool entry the entries commit to, leaving the bystander', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const handle = db.getDb();

    const author = makeTestIdentity();
    const victim = makeTestIdentity();

    // `confirmed` is the post the block commits to. `evictee` is the unrelated
    // post that must survive — someone else's unconfirmed sub-block, sitting in
    // every node's mempool. Until Phase 3b an attacker named it in the refs;
    // now it is simply a bystander, and the eviction must still miss it.
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

    const block = await makeCommittingBlock(
      { postId: confirmedId, authorHex: hex(author.userId) },
    );
    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    // The eviction ran on the committed id, so the bystander's entry is
    // untouched and still pending. Any consumer reading a list wider than
    // `subBlockEntries` would have taken `eviceeId` with it — which is what the
    // uncommitted field used to let an attacker arrange, and what this still
    // catches for a plain widening.
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

    const block = await makeCommittingBlock(
      { postId: confirmedId, authorHex: hex(author.userId) },
    );

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    // Forward pass: the entries loop confirmed exactly one post.
    expect(postStatus(handle, confirmedId)).toBe('confirmed');
    expect(postStatus(handle, unrelatedId)).toBe('pending');

    // The journal records that same list. `toEqual` on the whole array rather
    // than `toContain`: the failure this guards against is an *extra* id as
    // much as a missing one, and an extra one is what the deleted field used to
    // supply.
    const journalStore = await importJournalStore();
    const journal = journalStore.getBlockJournal(1);
    expect(journal).not.toBeNull();
    expect(journal!.confirmedSubBlockIds).toEqual([confirmedId]);
    expect(journal!.confirmedSubBlockIds).not.toContain(unrelatedId);

    // And the round trip closes. `revertBlock` is what a reorg replays, so this
    // is the inverse under test, not a stand-in for it: after it runs, nothing
    // the block confirmed is still confirmed, and the bystander is untouched.
    // Journalling anything wider left `confirmedId` permanently 'confirmed' at
    // a height whose block no longer exists, while un-confirming a post the
    // block never touched.
    const fork = await importForkResolution();
    fork.revertBlock(1);
    expect(postStatus(handle, confirmedId)).toBe('pending');
    expect(postStatus(handle, unrelatedId)).toBe('pending');
  });
});
