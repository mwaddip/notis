import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OrderingBlock } from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { BlockJournal } from '../../src/store/journal.js';
import { makeApplicableBlock, seedPostTx, makeTestIdentity } from '../helpers.js';

// ---------------------------------------------------------------------------
// A block's post ids come from its committed transactions — and so does the
// journal that inverts them (NODE_INTERFACE → Block Journal)
// ---------------------------------------------------------------------------
//
// The journal records exactly the ids the block committed to, so `revertBlock`
// un-confirms exactly what apply confirmed. The forward pass and its inverse
// both read `postsOf`, so they cannot disagree — which is the property, stated
// as one derivation rather than as two lists that happen to match.

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
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

/** DAG status of one post — 'confirmed', 'pending', or null if absent. */
function postStatus(db: Database.Database, postId: string): string | null {
  const row = db
    .prepare(`SELECT status FROM dag_posts WHERE id = ?`)
    .get(postId) as { status: string } | undefined;
  return row?.status ?? null;
}

describe('post ids are derived from the block\'s committed transactions', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('journals exactly the ids the block creates, so revert un-confirms what apply confirmed', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const handle = db.getDb();

    const author = makeTestIdentity();
    const victim = makeTestIdentity();

    // `committed` rides the block. `bystander` is an unrelated post whose
    // transaction the block does NOT carry — the control that makes every
    // assertion below about the committed list rather than about "some post".
    const committed = await seedPostTx(author, 'the block commits to this');
    const bystander = await seedPostTx(victim, 'never carried by any block');
    expect(bystander.postId).not.toBe(committed.postId);

    const block = await makeApplicableBlock({ utxoTxs: [committed.tx] });
    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    // ⛔ Apply STORED the post as well as confirming it — there is no
    // placeholder state, because the body carries the content.
    expect(postStatus(handle, committed.postId)).toBe('confirmed');
    expect(postStatus(handle, bystander.postId)).toBeNull();

    // The journal records that same list. `toEqual` on the whole array rather
    // than `toContain`: the failure this guards against is an *extra* id as
    // much as a missing one.
    const journalStore = await importJournalStore();
    const journal = journalStore.getBlockJournal(1);
    expect(journal).not.toBeNull();
    expect(journal!.confirmedPostIds).toEqual([committed.postId]);

    // The round trip closes. `revertBlock` is what a reorg replays, so this is
    // the inverse under test rather than a stand-in for it.
    const fork = await importForkResolution();
    fork.revertBlock(1);
    expect(postStatus(handle, committed.postId)).toBe('pending');
  });

  it('a block carrying no post transaction journals nothing', async () => {
    // The empty case, asserted rather than assumed: a coinbase-only block must
    // journal an empty list, not `undefined` and not the previous block's.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const block = await makeApplicableBlock();
    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const journalStore = await importJournalStore();
    expect(journalStore.getBlockJournal(1)!.confirmedPostIds).toEqual([]);
  });
});
