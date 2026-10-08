import { fixturePostId, makePostCommit, fixtureTxId} from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import {
  initDb,
  closeDb,
  insertPost,
  getPost as storeGetPost,
  queryPostsPage,
  getLikeRecordCount,
  getDescendantCount,
  hasLikeRecord,
  getAncestorsNearest,
  getSubtreePage,
  confirmPost,
  withdrawPost,
  getBlockCreatedAt,
  getPendingUtxoTxBytesByTxId,
  getUtxoTxTreeBytes,
  getUsernameByOwner,
  putUsername,
} from '../../src/store/index.js';
import { insertLikeRecord } from '../../src/store/likes.js';
import { FeedService } from '../../src/services/feed-service.js';
import type { PostJson, WithdrawnJson } from '../../src/services/feed-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(v: object | null): Record<string, unknown> {
  if (v === null) throw new Error('expected a DTO, got null');
  return Object.fromEntries(Object.entries(v));
}

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function insertTestPost(content: string, author: Uint8Array, parentRefs: string[]): string {
  const commit = makePostCommit(author, content, { parentRefs });
  const postId = fixturePostId(commit);
  insertPost(postId, fixtureTxId(commit), commit, content);
  return postId;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('feed-service', () => {
  let authorId: Uint8Array;
  let liveRootId: string;
  let liveReplyId: string;
  let feedService: FeedService;

  beforeEach(() => {
    initDb(':memory:');
    const keys = generateKeyPairSync('ed25519');
    authorId = rawPublicKey(keys.publicKey);

    liveRootId = insertTestPost('Live root', authorId, []);
    liveReplyId = insertTestPost('Live reply', authorId, [liveRootId]);

    feedService = new FeedService({
      getPost: storeGetPost,
      queryPostsPage,
      getLikeRecordCount,
      getDescendantCount,
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage,
      getBlockCreatedAt,
      getPendingUtxoTxBytesByTxId,
      getUtxoTxTreeBytes,
      getUsernameByOwner,
    });
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // getPost
  // -----------------------------------------------------------------------

  it('getPost returns a live post as serialized PostJson (control)', () => {
    const r = asRecord(feedService.getPost(liveRootId));
    expect(r).not.toBeNull();
    expect(r['id']).toBe(liveRootId);
    expect(r['content']).toBe('Live root');
    expect(r['contentHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(r['author']).toBe(Buffer.from(authorId).toString('hex'));
    expect(r['likeCount']).toBe(0);
    expect(r['likedByViewer']).toBeNull();
  });

  it('a live post carries no `kind` — clients discriminate on its presence', () => {
    const r = asRecord(feedService.getPost(liveRootId));
    expect('kind' in r).toBe(false);
  });

  it('getPost returns null for an unknown id', () => {
    expect(feedService.getPost('ab'.repeat(32))).toBeNull();
  });

  // -----------------------------------------------------------------------
  // getThread
  // -----------------------------------------------------------------------

  it('getThread returns full thread context for a live post (control)', () => {
    const t = feedService.getThread(liveReplyId, { limit: 50 });
    expect(t).not.toBeNull();
    expect(t!.post).not.toBeNull();
    expect((t!.post as PostJson).id).toBe(liveReplyId);
    expect(t!.ancestors.map((p) => p.id)).toEqual([liveRootId]);
    expect(t!.ancestorCount).toBe(1);
    expect(t!.descendants).toEqual([]);
    expect(t!.descendantCount).toBe(0);
    expect(t!.next).toBeNull();
    expect(t!.pending).toEqual([]);
    expect(t!.pendingCount).toBe(0);
  });

  it('getThread on a withdrawn subject carries its live ancestor and descendant, as a live subject would', () => {
    const parentId = insertTestPost('A root whose reply is withdrawn', authorId, []);
    confirmPost(parentId, 60, 0);
    const subjectId = insertTestPost('The withdrawn reply', authorId, [parentId]);
    confirmPost(subjectId, 60, 1);
    withdrawPost(subjectId, 61);
    const childId = insertTestPost('A live reply under the withdrawn one', authorId, [subjectId]);
    confirmPost(childId, 62, 0);

    const t = feedService.getThread(subjectId, { limit: 50 });
    expect(t).not.toBeNull();
    expect((t!.post as WithdrawnJson).kind).toBe('withdrawn');
    expect((t!.post as WithdrawnJson).parentRefs).toEqual([parentId]);
    expect(t!.ancestors.map((p) => p.id)).toEqual([parentId]);
    expect(t!.ancestorCount).toBe(1);
    expect(t!.descendants.map((p) => p.id)).toEqual([childId]);
    expect(t!.descendantCount).toBe(1);
    expect(t!.next).toBeNull();
  });

  it('getThread returns null for an unknown id', () => {
    expect(feedService.getThread('ab'.repeat(32), { limit: 50 })).toBeNull();
  });

  // -----------------------------------------------------------------------
  // status — the local column, on every path that serves a post
  // -----------------------------------------------------------------------

  it('getPost serves the stored status, and it tracks confirmation', () => {
    expect(asRecord(feedService.getPost(liveRootId))['status']).toBe('pending');

    confirmPost(liveRootId, 42, 0);
    expect(asRecord(feedService.getPost(liveRootId))['status']).toBe('confirmed');
  });

  it('every path that serves a post serves its status', () => {
    confirmPost(liveRootId, 42, 0);

    const result = feedService.queryPosts({ author: authorId, limit: 50 });
    expect((result.posts.find((p) => p.id === liveRootId) as PostJson).status).toBe('confirmed');
    expect((result.pending.find((p) => p.id === liveReplyId) as PostJson).status).toBe('pending');

    const thread = feedService.getThread(liveReplyId, { limit: 50 })!;
    expect((thread.post as PostJson).status).toBe('pending');
    expect(thread.ancestors.map((p) => (p as PostJson).status)).toEqual(['confirmed']);

    const rootThread = feedService.getThread(liveRootId, { limit: 50 })!;
    expect(rootThread.pending.map((p) => (p as PostJson).status)).toEqual(['pending']);
  });

  // -----------------------------------------------------------------------
  // descendantCount and authorName — NODE_INTERFACE → Posts, Usernames
  // -----------------------------------------------------------------------

  it('descendantCount and authorName ride every PostJson arm', () => {
    const grandchildId = insertTestPost('A pending grandchild', authorId, [liveReplyId]);
    confirmPost(liveRootId, 10, 0);
    confirmPost(liveReplyId, 11, 0);

    // Feed row: the confirmed root, 2 descendants (reply + grandchild), pending included
    const feed = feedService.queryPosts({ limit: 50 });
    const feedRow = feed.posts.find((p) => p.id === liveRootId) as PostJson;
    expect(feedRow.descendantCount).toBe(2);
    expect(feedRow.authorName).toBeNull();

    // Pending row: the grandchild, still pending, a leaf
    const pendingRow = feed.pending.find((p) => p.id === grandchildId) as PostJson;
    expect(pendingRow.descendantCount).toBe(0);
    expect(pendingRow.authorName).toBeNull();

    // Head
    const head = feedService.getPost(liveReplyId) as PostJson;
    expect(head.descendantCount).toBe(1);
    expect(head.authorName).toBeNull();

    // Ancestor
    const replyThread = feedService.getThread(liveReplyId, { limit: 50 })!;
    const ancestor = replyThread.ancestors[0] as PostJson;
    expect(ancestor.id).toBe(liveRootId);
    expect(ancestor.descendantCount).toBe(2);
    expect(ancestor.authorName).toBeNull();

    // Descendant
    const rootThread2 = feedService.getThread(liveRootId, { limit: 50 })!;
    const descendant = rootThread2.descendants[0] as PostJson;
    expect(descendant.id).toBe(liveReplyId);
    expect(descendant.descendantCount).toBe(1);
    expect(descendant.authorName).toBeNull();
  });

  it('authorName is read once per distinct author per response, and again on the next call', () => {
    const keysB = generateKeyPairSync('ed25519');
    const authorB = rawPublicKey(keysB.publicKey);
    insertTestPost('A second post by A', authorId, []);
    insertTestPost('A post by B', authorB, []);

    let nameCalls = 0;
    const countingService = new FeedService({
      getPost: storeGetPost,
      queryPostsPage,
      getLikeRecordCount,
      getDescendantCount,
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage,
      getBlockCreatedAt,
      getPendingUtxoTxBytesByTxId,
      getUtxoTxTreeBytes,
      getUsernameByOwner: (owner) => {
        nameCalls++;
        return getUsernameByOwner(owner);
      },
    });

    // The pending window holds 4 posts (liveRootId, liveReplyId, +2 new) across 2 distinct authors.
    countingService.queryPosts({ limit: 50 });
    expect(nameCalls).toBe(2);

    countingService.queryPosts({ limit: 50 });
    expect(nameCalls).toBe(4);
  });

  it('authorName is read once per distinct author across a withdrawn row and a live row by the same author', () => {
    const withdrawnId = insertTestPost('A post about to be withdrawn', authorId, []);
    confirmPost(withdrawnId, 40, 0);
    withdrawPost(withdrawnId, 41);

    let nameCalls = 0;
    const countingService = new FeedService({
      getPost: storeGetPost,
      queryPostsPage,
      getLikeRecordCount,
      getDescendantCount,
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage,
      getBlockCreatedAt,
      getPendingUtxoTxBytesByTxId,
      getUtxoTxTreeBytes,
      getUsernameByOwner: (owner) => {
        nameCalls++;
        return getUsernameByOwner(owner);
      },
    });

    // One confirmed row (the withdrawn post) plus liveRootId/liveReplyId still
    // pending — three rows, one distinct author, in one response.
    const feed = countingService.queryPosts({ limit: 50 });
    expect(feed.posts.some((p) => p.id === withdrawnId)).toBe(true);
    expect(feed.pending.length).toBe(2);
    expect(nameCalls).toBe(1);
  });

  // -----------------------------------------------------------------------
  // WithdrawnJson carries descendantCount and authorName
  // -----------------------------------------------------------------------

  it('descendantCount and authorName ride every WithdrawnJson arm too', () => {
    const withdrawnRootId = insertTestPost('A root about to be withdrawn', authorId, []);
    confirmPost(withdrawnRootId, 30, 0);
    const rootChildId = insertTestPost('Its live child', authorId, [withdrawnRootId]);
    confirmPost(rootChildId, 31, 0);
    withdrawPost(withdrawnRootId, 32);

    const liveParentId = insertTestPost('A live parent whose reply withdraws', authorId, []);
    confirmPost(liveParentId, 33, 0);
    const withdrawnChildId = insertTestPost('A reply about to be withdrawn', authorId, [liveParentId]);
    confirmPost(withdrawnChildId, 34, 0);
    withdrawPost(withdrawnChildId, 35);

    // getPost
    const head = feedService.getPost(withdrawnRootId) as WithdrawnJson;
    expect(head.kind).toBe('withdrawn');
    expect(head.descendantCount).toBe(1);
    expect(head.authorName).toBeNull();

    // listing
    const feed = feedService.queryPosts({ limit: 50 });
    const feedRow = feed.posts.find((p) => p.id === withdrawnRootId) as WithdrawnJson;
    expect(feedRow.descendantCount).toBe(1);
    expect(feedRow.authorName).toBeNull();

    // thread head
    const thread = feedService.getThread(withdrawnRootId, { limit: 50 })!;
    const threadHead = thread.post as WithdrawnJson;
    expect(threadHead.kind).toBe('withdrawn');
    expect(threadHead.descendantCount).toBe(1);
    expect(threadHead.authorName).toBeNull();

    // thread descendant
    const parentThread = feedService.getThread(liveParentId, { limit: 50 })!;
    const descendant = parentThread.descendants[0] as WithdrawnJson;
    expect(descendant.id).toBe(withdrawnChildId);
    expect(descendant.kind).toBe('withdrawn');
    expect(descendant.descendantCount).toBe(0);
    expect(descendant.authorName).toBeNull();
  });

  it('getThread reads the head\'s descendantCount once, and the head and the thread agree', () => {
    const descendantCalls: Record<string, number> = {};
    const countingGetDescendantCount = (postId: string): number => {
      descendantCalls[postId] = (descendantCalls[postId] ?? 0) + 1;
      return getDescendantCount(postId);
    };
    // Mirrors the store's own delegation (Store Interface → Posts DAG:
    // getSubtreePage's count runs getDescendantCount, stated once) through the
    // same dependency seam, since the store's own internal call is not
    // observable through injected deps.
    const countingGetSubtreePage: typeof getSubtreePage = (postId, page) => {
      const real = getSubtreePage(postId, page);
      return { ...real, count: countingGetDescendantCount(postId) };
    };

    const countingService = new FeedService({
      getPost: storeGetPost,
      queryPostsPage,
      getLikeRecordCount,
      getDescendantCount: countingGetDescendantCount,
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage: countingGetSubtreePage,
      getBlockCreatedAt,
      getPendingUtxoTxBytesByTxId,
      getUtxoTxTreeBytes,
      getUsernameByOwner,
    });

    const t = countingService.getThread(liveReplyId, { limit: 50 })!;
    expect(descendantCalls[liveReplyId]).toBe(1);
    expect((t.post as PostJson).descendantCount).toBe(t.descendantCount);
  });

  // -----------------------------------------------------------------------
  // authorName with a live name — NODE_INTERFACE → Usernames
  // -----------------------------------------------------------------------

  it('authorName rides a live row as typed when the author holds a name', () => {
    putUsername({
      nameLower: Buffer.from(authorId).toString('hex').slice(0, 10),
      name: 'AuthorAlias',
      owner: Buffer.from(authorId).toString('hex'),
      boxId: 'bb'.repeat(32),
      claimedAtBlock: 50,
    });

    const head = feedService.getPost(liveRootId) as PostJson;
    expect(head.authorName).toBe('AuthorAlias');
  });

  it('authorName rides a withdrawn row as typed when the author holds a name', () => {
    putUsername({
      nameLower: Buffer.from(authorId).toString('hex').slice(0, 10),
      name: 'AuthorAlias',
      owner: Buffer.from(authorId).toString('hex'),
      boxId: 'bb'.repeat(32),
      claimedAtBlock: 50,
    });

    const withdrawnId = insertTestPost('To be withdrawn for name test', authorId, []);
    confirmPost(withdrawnId, 51, 0);
    withdrawPost(withdrawnId, 52);

    const head = feedService.getPost(withdrawnId) as WithdrawnJson;
    expect(head.authorName).toBe('AuthorAlias');
  });

  it('authorName is null for an author with no name', () => {
    const noNameKeys = generateKeyPairSync('ed25519');
    const noNameAuthor = rawPublicKey(noNameKeys.publicKey);
    const postId = insertTestPost('No name author', noNameAuthor, []);

    const head = feedService.getPost(postId) as PostJson;
    expect(head.authorName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tx — NODE_INTERFACE → Posts → "The creating transaction rides a post row"
// ---------------------------------------------------------------------------

import type { StoredPost, PostStatus } from '../../src/store/posts.js';
import type { PostCommit, TxId } from '@dagsocial/types';
import { computePostId, computeTxId, encodeTx, decodeTx, encodeUtxoTxTree } from '@dagsocial/types';
import { makePostTx, makeTestIdentity } from '../helpers.js';
import {
  ConfirmedPostTxNotInBlockBodyError,
  UnreadableStoredBlockError,
} from '../../src/services/corrupt-state.js';

/** Build a StoredPost from pieces, with a real-shaped `txId`. */
function storedPost(args: {
  id: string;
  txId: string;
  commit: PostCommit;
  content: string | null;
  status: PostStatus;
  blockHeight: number | null;
  blockIndex: number | null;
  withdrawnAtHeight?: number | null;
}): StoredPost {
  return {
    id: args.id,
    txId: args.txId,
    content: args.content,
    contentHash: Buffer.from(args.commit.contentHash).toString('hex'),
    author: args.commit.author,
    parentRefs: args.commit.parentRefs,
    protocolVersion: args.commit.protocolVersion,
    type: args.commit.type,
    status: args.status,
    blockHeight: args.blockHeight,
    blockIndex: args.blockIndex,
    withdrawnAtHeight: args.withdrawnAtHeight ?? null,
  };
}

interface TxMockState {
  byId: Map<string, StoredPost>;
  page: StoredPost[];
  pending: StoredPost[];
  // The raw `utxotx_tree_bytes` of each seeded block, keyed by height — the
  // one column `TxBytesResolver.confirmed` reads through `getUtxoTxTreeBytes`
  // (NODE_INTERFACE → Posts → "The creating transaction rides a post row").
  bodyBytesByHeight: Map<number, Uint8Array>;
  // The last bytes `getUtxoTxTreeBytes` handed back — mirrors what the
  // resolver holds (one body in memory at a time).
  lastReadBytes: Uint8Array | null;
  pendingByTxId: Map<string, Uint8Array>;
  bodyReads: number[];      // heights read, in order — one entry per real body read
  descendants: StoredPost[];
  ancestors: StoredPost[];
}

function seedBody(state: TxMockState, height: number, utxoTxIds: string[], utxoTxs: Uint8Array[]): void {
  state.bodyBytesByHeight.set(height, encodeUtxoTxTree({ utxoTxIds, utxoTxs }));
}

function makeTxMockFeed(state: TxMockState): FeedService {
  return new FeedService({
    getPost: (id) => state.byId.get(id) ?? null,
    queryPostsPage: () => ({ rows: state.page, next: null, pending: state.pending, pendingCount: state.pending.length }),
    getLikeRecordCount: () => 0,
    getDescendantCount: () => state.descendants.length,
    hasLikeRecord: () => false,
    getAncestorsNearest: () => ({ rows: state.ancestors, count: state.ancestors.length }),
    getSubtreePage: () => ({ rows: state.descendants, next: null, count: state.descendants.length, pending: state.pending, pendingCount: state.pending.length }),
    getBlockCreatedAt: () => null,
    getUsernameByOwner: () => null,
    getPendingUtxoTxBytesByTxId: (txId: TxId) => state.pendingByTxId.get(txId) ?? null,
    getUtxoTxTreeBytes: (height: number) => {
      state.bodyReads.push(height);
      const bytes = state.bodyBytesByHeight.get(height) ?? null;
      state.lastReadBytes = bytes;
      return bytes;
    },
  });
}

/** Build a real post + its transaction, and return the pieces for a scenario. */
function makeScenarioPost(content = 'hello'): {
  commit: PostCommit; postId: string; txId: string; txBytes: Uint8Array;
} {
  const id = makeTestIdentity();
  const { commit, tx, postId } = makePostTx(id, content);
  const txBytes = encodeTx(tx);
  return { commit, postId, txId: computeTxId(tx), txBytes };
}

describe('feed-service — tx bytes ride the row (NODE_INTERFACE → Posts → "The creating transaction rides a post row")', () => {
  function emptyState(): TxMockState {
    return {
      byId: new Map(),
      page: [],
      pending: [],
      bodyBytesByHeight: new Map(),
      lastReadBytes: null,
      pendingByTxId: new Map(),
      bodyReads: [],
      descendants: [],
      ancestors: [],
    };
  }

  it('a pending row\'s `tx` decodes to a transaction whose computePostId(computeTxId(tx), 0) is the row\'s id, and whose computeTxId is the row\'s txId', () => {
    const s = emptyState();
    const { commit, postId, txId, txBytes } = makeScenarioPost();
    const row = storedPost({ id: postId, txId, commit, content: 'hello', status: 'pending', blockHeight: null, blockIndex: null });
    s.byId.set(postId, row);
    s.pendingByTxId.set(txId, txBytes);
    const feed = makeTxMockFeed(s);

    const r = feed.getPost(postId, null, true) as PostJson;
    expect(r.txId).toBe(txId);
    expect(typeof r.tx).toBe('string');
    const decoded = decodeTx(new Uint8Array(Buffer.from(r.tx as string, 'hex')));
    expect(computeTxId(decoded)).toBe(txId);
    expect(computePostId(computeTxId(decoded), 0)).toBe(postId);
  });

  it('a confirmed row\'s `tx` reads the stored body at blockHeight — same identities round-trip', () => {
    const s = emptyState();
    const { commit, postId, txId, txBytes } = makeScenarioPost('a confirmed body');
    const row = storedPost({ id: postId, txId, commit, content: 'a confirmed body', status: 'confirmed', blockHeight: 10, blockIndex: 0 });
    s.byId.set(postId, row);
    seedBody(s, 10, [txId], [txBytes]);
    const feed = makeTxMockFeed(s);

    const r = feed.getPost(postId, null, true) as PostJson;
    const decoded = decodeTx(new Uint8Array(Buffer.from(r.tx as string, 'hex')));
    expect(computeTxId(decoded)).toBe(txId);
    expect(computePostId(computeTxId(decoded), 0)).toBe(postId);
  });

  it('a pending row whose pool entry is gone answers tx: null', () => {
    // A pending row (status: 'pending', blockHeight: null) with no entry
    // under its tx_id in the pool. A placeholder is a CONFIRMED row with
    // null content, written by writeBlockEffects when a block confirms a
    // post whose packet this node never received — the real-store cases
    // below cover that path.
    const s = emptyState();
    const { commit, postId, txId } = makeScenarioPost();
    const row = storedPost({ id: postId, txId, commit, content: null, status: 'pending', blockHeight: null, blockIndex: null });
    s.byId.set(postId, row);
    const feed = makeTxMockFeed(s);

    const r = feed.getPost(postId, null, true) as PostJson;
    expect(r.content).toBeNull();
    expect(r.tx).toBeNull();
    expect(r.txId).toBe(txId);
  });

  it('a withdrawn row carries `txId` and no `tx` key, both with and without ?tx=1', () => {
    const s = emptyState();
    const { commit, postId, txId } = makeScenarioPost();
    const row = storedPost({ id: postId, txId, commit, content: null, status: 'confirmed', blockHeight: 10, blockIndex: 0, withdrawnAtHeight: 11 });
    s.byId.set(postId, row);
    const feed = makeTxMockFeed(s);

    const withTx = feed.getPost(postId, null, true) as unknown as WithdrawnJson;
    expect(withTx.kind).toBe('withdrawn');
    expect(withTx.txId).toBe(txId);
    expect('tx' in withTx).toBe(false);

    const withoutTx = feed.getPost(postId, null, false) as unknown as WithdrawnJson;
    expect(withoutTx.txId).toBe(txId);
    expect('tx' in withoutTx).toBe(false);
  });

  it('without tx=1 no row of any list carries a `tx` key — getPost, queryPosts and getThread alike', () => {
    const s = emptyState();
    const { commit, postId, txId, txBytes } = makeScenarioPost();
    const row = storedPost({ id: postId, txId, commit, content: 'x', status: 'pending', blockHeight: null, blockIndex: null });
    s.byId.set(postId, row);
    s.page.push(row);
    s.pending.push(row);
    s.pendingByTxId.set(txId, txBytes);
    const feed = makeTxMockFeed(s);

    const one = feed.getPost(postId) as PostJson;
    expect('tx' in one).toBe(false);
    const feedResult = feed.queryPosts({ limit: 10 });
    for (const p of feedResult.posts) expect('tx' in p).toBe(false);
    for (const p of feedResult.pending) expect('tx' in p).toBe(false);
    const thread = feed.getThread(postId, { limit: 10 });
    expect('tx' in (thread!.post as PostJson)).toBe(false);
  });

  it('a thread\'s post, ancestors, descendants and pending all carry `tx` under tx=1, and GET /posts\'s posts and pending too', () => {
    const s = emptyState();
    const subject = makeScenarioPost('the subject');
    const ancestor = makeScenarioPost('an ancestor');
    const descendant = makeScenarioPost('a descendant');
    const pending = makeScenarioPost('a pending in subtree');

    const subjectRow = storedPost({ id: subject.postId, txId: subject.txId, commit: subject.commit, content: 'the subject', status: 'confirmed', blockHeight: 5, blockIndex: 0 });
    const ancestorRow = storedPost({ id: ancestor.postId, txId: ancestor.txId, commit: ancestor.commit, content: 'an ancestor', status: 'confirmed', blockHeight: 4, blockIndex: 0 });
    const descendantRow = storedPost({ id: descendant.postId, txId: descendant.txId, commit: descendant.commit, content: 'a descendant', status: 'confirmed', blockHeight: 6, blockIndex: 0 });
    const pendingRow = storedPost({ id: pending.postId, txId: pending.txId, commit: pending.commit, content: 'a pending in subtree', status: 'pending', blockHeight: null, blockIndex: null });

    s.byId.set(subject.postId, subjectRow);
    s.ancestors.push(ancestorRow);
    s.descendants.push(descendantRow);
    s.pending.push(pendingRow);
    s.page.push(subjectRow, ancestorRow, descendantRow);
    seedBody(s, 4, [ancestor.txId], [ancestor.txBytes]);
    seedBody(s, 5, [subject.txId], [subject.txBytes]);
    seedBody(s, 6, [descendant.txId], [descendant.txBytes]);
    s.pendingByTxId.set(pending.txId, pending.txBytes);
    const feed = makeTxMockFeed(s);

    const t = feed.getThread(subject.postId, { limit: 10 }, null, true)!;
    expect(typeof (t.post as PostJson).tx).toBe('string');
    for (const a of t.ancestors) expect(typeof (a as PostJson).tx).toBe('string');
    for (const d of t.descendants) expect(typeof (d as PostJson).tx).toBe('string');
    for (const p of t.pending) expect(typeof (p as PostJson).tx).toBe('string');

    const q = feed.queryPosts({ limit: 10, tx: true });
    for (const p of q.posts) expect(typeof (p as PostJson).tx).toBe('string');
    for (const p of q.pending) expect(typeof (p as PostJson).tx).toBe('string');
  });

  it('a reorg that un-confirms a post answers its `tx` as `null` — the pool entry was removed at the confirming block\'s apply and nothing restores it on unconfirm', () => {
    // The mempool entry was removed by writeBlockEffects at confirm time
    // (block-apply.ts calls removeUtxoTxEntry); fork-resolution\'s revert
    // runs unconfirmPost but does not re-admit the transaction, so the
    // row is pending with no pool entry and the resolver answers null.
    const s = emptyState();
    const { commit, postId, txId } = makeScenarioPost();
    const row = storedPost({ id: postId, txId, commit, content: 'x', status: 'pending', blockHeight: null, blockIndex: null });
    s.byId.set(postId, row);
    const feed = makeTxMockFeed(s);

    const r = feed.getPost(postId, null, true) as PostJson;
    expect(r.status).toBe('pending');
    expect(r.tx).toBeNull();
  });

  it('a page whose rows sit in N distinct blocks reads N bodies, not one per row', () => {
    const s = emptyState();
    const rows: StoredPost[] = [];
    // Three rows in height 5, two in height 6, one in height 7.
    for (let h = 5; h <= 7; h++) {
      const utxoTxIds: string[] = [];
      const utxoTxs: Uint8Array[] = [];
      const want = h === 5 ? 3 : h === 6 ? 2 : 1;
      for (let i = 0; i < want; i++) {
        const p = makeScenarioPost(`h${h}-${i}`);
        rows.push(storedPost({ id: p.postId, txId: p.txId, commit: p.commit, content: `h${h}-${i}`, status: 'confirmed', blockHeight: h, blockIndex: i }));
        utxoTxIds.push(p.txId);
        utxoTxs.push(p.txBytes);
      }
      seedBody(s, h, utxoTxIds, utxoTxs);
    }
    s.page = rows;
    for (const r of rows) s.byId.set(r.id, r);
    const feed = makeTxMockFeed(s);

    const q = feed.queryPosts({ limit: 50, tx: true });
    expect(q.posts.length).toBe(6);
    // Three distinct heights; three body reads total — not one per row.
    expect(s.bodyReads).toEqual([5, 6, 7]);
  });

  it('a confirmed row whose block lists no such id throws ConfirmedPostTxNotInBlockBodyError (CorruptChainStateError)', () => {
    const s = emptyState();
    const { commit, postId, txId } = makeScenarioPost();
    const row = storedPost({ id: postId, txId, commit, content: 'x', status: 'confirmed', blockHeight: 10, blockIndex: 0 });
    s.byId.set(postId, row);
    // The body at height 10 holds no tx matching txId.
    seedBody(s, 10, ['ff'.repeat(32)], [new Uint8Array([0])]);
    const feed = makeTxMockFeed(s);

    expect(() => feed.getPost(postId, null, true)).toThrow(ConfirmedPostTxNotInBlockBodyError);
  });

  it('a page whose rows sit in N distinct blocks performs N body reads and holds the last height\'s bytes', () => {
    // TYPES_INTERFACE → One transaction of a body: "whatever a page holds,
    // one body's bytes are in memory at a time". A page's rows arrive in
    // `ORDER BY block_height, block_index` (store/posts.ts), so rows of one
    // block reuse the last bytes read.
    const s = emptyState();
    const rows: StoredPost[] = [];
    const heights = [5, 6, 7, 8];
    for (const h of heights) {
      const p = makeScenarioPost(`row-${h}`);
      rows.push(storedPost({ id: p.postId, txId: p.txId, commit: p.commit, content: `row-${h}`, status: 'confirmed', blockHeight: h, blockIndex: 0 }));
      seedBody(s, h, [p.txId], [p.txBytes]);
    }
    s.page = rows;
    for (const r of rows) s.byId.set(r.id, r);
    const feed = makeTxMockFeed(s);

    const q = feed.queryPosts({ limit: 50, tx: true });
    expect(q.posts.length).toBe(heights.length);
    // One read per distinct height.
    expect(s.bodyReads).toEqual(heights);
    // The last-returned bytes mirror what the resolver holds — one body's
    // bytes at a time, that of the last height read.
    expect(s.lastReadBytes).not.toBeNull();
    expect(s.lastReadBytes).toEqual(s.bodyBytesByHeight.get(heights[heights.length - 1]!));
  });

  it('rows that share a block height read the body once, not once per row', () => {
    const s = emptyState();
    const rows: StoredPost[] = [];
    const utxoTxIds: string[] = [];
    const utxoTxs: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) {
      const p = makeScenarioPost(`same-block-${i}`);
      rows.push(storedPost({ id: p.postId, txId: p.txId, commit: p.commit, content: `same-block-${i}`, status: 'confirmed', blockHeight: 12, blockIndex: i }));
      utxoTxIds.push(p.txId);
      utxoTxs.push(p.txBytes);
    }
    seedBody(s, 12, utxoTxIds, utxoTxs);
    for (const r of rows) s.byId.set(r.id, r);
    s.page = rows;
    const feed = makeTxMockFeed(s);

    const q = feed.queryPosts({ limit: 50, tx: true });
    expect(q.posts.length).toBe(5);
    expect(s.bodyReads).toEqual([12]);
  });

  it('a confirmed row at a height with no stored block throws UnreadableStoredBlockError', () => {
    const s = emptyState();
    const { commit, postId, txId } = makeScenarioPost();
    const row = storedPost({ id: postId, txId, commit, content: 'x', status: 'confirmed', blockHeight: 42, blockIndex: 0 });
    s.byId.set(postId, row);
    // No body seeded at height 42.
    const feed = makeTxMockFeed(s);

    expect(() => feed.getPost(postId, null, true)).toThrow(UnreadableStoredBlockError);
  });

  it('a height whose stored body is cut short throws UnreadableStoredBlockError', () => {
    const s = emptyState();
    const { commit, postId, txId, txBytes } = makeScenarioPost();
    const row = storedPost({ id: postId, txId, commit, content: 'x', status: 'confirmed', blockHeight: 43, blockIndex: 0 });
    s.byId.set(postId, row);
    // Seed a well-formed body, then truncate the stored bytes so the walk
    // raises `ReaderError` out of `utxoTxBytesIn` — the resolver promotes it
    // to the same corruption class `rowToOrderingBlock` raises for an
    // unreadable stored body (store/ordering.ts → `createOrderingBlock`'s
    // provenance claim).
    const full = encodeUtxoTxTree({ utxoTxIds: [txId], utxoTxs: [txBytes] });
    s.bodyBytesByHeight.set(43, full.slice(0, full.length - 4));
    const feed = makeTxMockFeed(s);

    expect(() => feed.getPost(postId, null, true)).toThrow(UnreadableStoredBlockError);
  });
});

// ---------------------------------------------------------------------------
// Over the real store — a real transaction, the real mempool, a real
// ordering_blocks row, and the real `getPendingUtxoTxBytesByTxId` and
// `getOrderingBlock`. The branches above pin FeedService's shape; these
// pin that the real store answers each branch's inputs.
// NODE_INTERFACE → Posts → "The creating transaction rides a post row".
// ---------------------------------------------------------------------------

import { getDb, closeDb as closeDb2, initDb as initDb2 } from '../../src/store/db.js';
import {
  encodeHeader,
  encodeInterlinks,
  PROTOCOL_VERSION as PROTO_VER,
} from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';
import { blockHash as computeBlockHash } from '@dagsocial/validation';
import { insertUtxoTx as realInsertUtxoTx } from '../../src/store/mempool.js';
import {
  insertPost as realInsertPost,
  confirmPost as realConfirmPost,
} from '../../src/store/posts.js';

/**
 * Seed an ordering_blocks row carrying the single transaction `tx` with id
 * `txId` and bytes `txBytes`. The header is minimal but encodable, so
 * `rowToOrderingBlock` decodes it and `getOrderingBlock` answers the real
 * body under `block_height`.
 */
function seedOrderingBlockRow(height: number, txId: string, txBytes: Uint8Array): void {
  const header: BlockHeader = {
    protocolVersion: PROTO_VER,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 1,
    createdAt: height * 60_000,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  const hash = computeBlockHash(header);
  if (hash === null) throw new Error('synthetic header must hash');
  getDb().prepare(
    `INSERT INTO ordering_blocks
       (height, header_bytes, utxotx_tree_bytes, validator_signature,
        created_at, block_hash, interlinks)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    height,
    Buffer.from(encodeHeader(header)),
    Buffer.from(encodeUtxoTxTree({ utxoTxIds: [txId], utxoTxs: [txBytes] })),
    Buffer.from(new Uint8Array(64)),
    header.createdAt,
    hash,
    Buffer.from(encodeInterlinks([])),
  );
}

function realStoreFeedService(): FeedService {
  return new FeedService({
    getPost: storeGetPost,
    queryPostsPage,
    getLikeRecordCount,
    getDescendantCount,
    hasLikeRecord,
    getAncestorsNearest,
    getSubtreePage,
    getBlockCreatedAt,
    getUsernameByOwner,
    getPendingUtxoTxBytesByTxId,
    getUtxoTxTreeBytes,
  });
}

describe('feed-service — tx bytes ride the row, over the real store', () => {
  beforeEach(() => { initDb2(':memory:'); });
  afterEach(() => { closeDb2(); });

  it('case 1 — a submitted post, pending: tx reads from the pool', () => {
    const id = makeTestIdentity();
    const { commit, tx, postId, content } = makePostTx(id, 'the first real-store case');
    const txId = computeTxId(tx);
    const txBytes = encodeTx(tx);

    realInsertUtxoTx(tx, 1000);
    realInsertPost(postId, txId, commit, content);

    const r = realStoreFeedService().getPost(postId, null, true) as PostJson;
    expect(r.txId).toBe(txId);
    expect(typeof r.tx).toBe('string');
    const decoded = decodeTx(new Uint8Array(Buffer.from(r.tx as string, 'hex')));
    expect(computeTxId(decoded)).toBe(txId);
    expect(computePostId(computeTxId(decoded), 0)).toBe(postId);
    // Byte-equal to the real tx bytes.
    expect(r.tx).toBe(Buffer.from(txBytes).toString('hex'));
  });

  it('case 2 — the same post after the block that confirms it: tx reads from the stored body, byte-equal to case 1', () => {
    const id = makeTestIdentity();
    const { commit, tx, postId, content } = makePostTx(id, 'the second real-store case');
    const txId = computeTxId(tx);
    const txBytes = encodeTx(tx);

    // Pending first — the hex that case 1 would answer.
    realInsertUtxoTx(tx, 1000);
    realInsertPost(postId, txId, commit, content);
    const pendingHex = (realStoreFeedService().getPost(postId, null, true) as PostJson).tx;

    // The block confirms it — `writeBlockEffects` removes the pool entry and
    // the body carries the tx. Seed the row directly, confirm the post.
    seedOrderingBlockRow(10, txId, txBytes);
    realConfirmPost(postId, 10, 0);
    // writeBlockEffects would call removeUtxoTxEntry; mirror that so the
    // pool no longer answers under the row's tx_id.
    getDb().prepare('DELETE FROM mempool WHERE tx_id = ?').run(txId);

    const r = realStoreFeedService().getPost(postId, null, true) as PostJson;
    expect(r.txId).toBe(txId);
    expect(typeof r.tx).toBe('string');
    expect(r.tx).toBe(pendingHex);
    expect(r.tx).toBe(Buffer.from(txBytes).toString('hex'));
  });

  it('case 3 — a post this node first sees in an applied block (placeholder): confirmed, content: null, tx from the stored body', () => {
    const id = makeTestIdentity();
    const { commit, tx, postId } = makePostTx(id, 'the placeholder real-store case');
    const txId = computeTxId(tx);
    const txBytes = encodeTx(tx);

    // No pool entry ever. `writeBlockEffects` inserts the row with
    // `content: null` and confirms it in one step.
    realInsertPost(postId, txId, commit, null);
    seedOrderingBlockRow(11, txId, txBytes);
    realConfirmPost(postId, 11, 0);

    const r = realStoreFeedService().getPost(postId, null, true) as PostJson;
    expect(r.content).toBeNull();
    expect(r.status).toBe('confirmed');
    expect(r.txId).toBe(txId);
    expect(r.tx).toBe(Buffer.from(txBytes).toString('hex'));
  });

});

// ---------------------------------------------------------------------------
// NODE_INTERFACE → Posts → "A light row is a post's id and the node's word"
// ---------------------------------------------------------------------------

import type { LightJson } from '../../src/services/feed-service.js';

const LIGHT_KEYS = [
  'kind', 'id', 'parentRefs', 'status', 'blockHeight', 'blockIndex',
  'blockCreatedAt', 'likeCount', 'descendantCount', 'authorName',
  'likedByViewer',
] as const;

describe('feed-service — the light projection', () => {
  let authorId: Uint8Array;
  let liveRootId: string;
  let liveReplyId: string;
  let feedService: FeedService;

  beforeEach(() => {
    initDb(':memory:');
    const keys = generateKeyPairSync('ed25519');
    authorId = rawPublicKey(keys.publicKey);
    liveRootId = insertTestPost('Light root', authorId, []);
    liveReplyId = insertTestPost('Light reply', authorId, [liveRootId]);
    feedService = new FeedService({
      getPost: storeGetPost,
      queryPostsPage,
      getLikeRecordCount,
      getDescendantCount,
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage,
      getBlockCreatedAt,
      getPendingUtxoTxBytesByTxId,
      getUtxoTxTreeBytes,
      getUsernameByOwner,
    });
  });

  afterEach(() => { closeDb(); });

  it('a light page\'s live rows carry exactly the eleven LightJson keys', () => {
    confirmPost(liveRootId, 100, 0);
    const result = feedService.queryPosts({ limit: 50, light: true });
    const row = result.posts.find((p) => p.id === liveRootId) as LightJson;
    expect(row.kind).toBe('light');
    expect(Object.keys(row).sort()).toEqual([...LIGHT_KEYS].sort());
  });

  it('a light page carries the full page\'s ids in order and the full page\'s next, pendingCount', () => {
    confirmPost(liveRootId, 101, 0);
    confirmPost(liveReplyId, 102, 0);
    const full = feedService.queryPosts({ limit: 50 });
    const light = feedService.queryPosts({ limit: 50, light: true });
    expect(light.posts.map((p) => p.id)).toEqual(full.posts.map((p) => p.id));
    expect(light.pending.map((p) => p.id)).toEqual(full.pending.map((p) => p.id));
    expect(light.next).toEqual(full.next);
    expect(light.pendingCount).toBe(full.pendingCount);
  });

  it('a light page under roots=1 restricts to roots, as the full page does', () => {
    confirmPost(liveRootId, 103, 0);
    confirmPost(liveReplyId, 104, 0);
    const light = feedService.queryPosts({ limit: 50, roots: true, light: true });
    const full = feedService.queryPosts({ limit: 50, roots: true });
    expect(light.posts.map((p) => p.id)).toEqual(full.posts.map((p) => p.id));
    expect(light.posts.find((p) => p.id === liveReplyId)).toBeUndefined();
  });

  it('a light page under author= filters as the full page does', () => {
    const keysB = generateKeyPairSync('ed25519');
    const authorB = rawPublicKey(keysB.publicKey);
    const otherId = insertTestPost('A post by B', authorB, []);
    confirmPost(liveRootId, 105, 0);
    confirmPost(otherId, 106, 0);
    const light = feedService.queryPosts({ limit: 50, author: authorId, light: true });
    const full = feedService.queryPosts({ limit: 50, author: authorId });
    expect(light.posts.map((p) => p.id)).toEqual(full.posts.map((p) => p.id));
    expect(light.posts.find((p) => p.id === otherId)).toBeUndefined();
  });

  it('a light thread\'s post, ancestors, descendants and pending are all light; counts and next match the full form', () => {
    confirmPost(liveRootId, 110, 0);
    confirmPost(liveReplyId, 111, 0);
    const grandchildId = insertTestPost('A grandchild', authorId, [liveReplyId]);
    const fullThread = feedService.getThread(liveReplyId, { limit: 50 })!;
    const lightThread = feedService.getThread(liveReplyId, { limit: 50 }, null, false, true)!;
    expect((lightThread.post as LightJson).kind).toBe('light');
    for (const a of lightThread.ancestors) expect((a as LightJson).kind).toBe('light');
    for (const d of lightThread.descendants) expect((d as LightJson).kind).toBe('light');
    for (const p of lightThread.pending) expect((p as LightJson).kind).toBe('light');
    expect(lightThread.ancestorCount).toBe(fullThread.ancestorCount);
    expect(lightThread.descendantCount).toBe(fullThread.descendantCount);
    expect(lightThread.next).toEqual(fullThread.next);
    expect(lightThread.pendingCount).toBe(fullThread.pendingCount);
    // Pending ids match the full thread's pending ids.
    expect(lightThread.pending.map((p) => p.id)).toEqual(fullThread.pending.map((p) => p.id));
    expect(lightThread.pending.map((p) => p.id)).toContain(grandchildId);
  });

  it('a withdrawn row among a light answer is its WithdrawnJson, whole', () => {
    const withdrawnId = insertTestPost('A post about to be withdrawn', authorId, []);
    confirmPost(withdrawnId, 120, 0);
    withdrawPost(withdrawnId, 121);
    const result = feedService.queryPosts({ limit: 50, light: true });
    const row = result.posts.find((p) => p.id === withdrawnId) as WithdrawnJson;
    expect(row.kind).toBe('withdrawn');
    expect(typeof row.txId).toBe('string');
    expect(typeof row.author).toBe('string');
    expect(row.parentRefs).toEqual([]);
    expect(row.withdrawnAtHeight).toBe(121);
  });

  it('likedByViewer follows viewer on a light row, null without one', () => {
    confirmPost(liveRootId, 130, 0);
    const keys = generateKeyPairSync('ed25519');
    const viewer = rawPublicKey(keys.publicKey);
    insertLikeRecord(liveRootId, viewer, 131);

    const withViewer = feedService.queryPosts({ limit: 50, viewer, light: true });
    const row = withViewer.posts.find((p) => p.id === liveRootId) as LightJson;
    expect(row.likedByViewer).toBe(true);

    const withoutViewer = feedService.queryPosts({ limit: 50, light: true });
    const row2 = withoutViewer.posts.find((p) => p.id === liveRootId) as LightJson;
    expect(row2.likedByViewer).toBeNull();
  });
});

describe('feed-service — a light read of a confirmed row with no body in its block does not read the body', () => {
  it('getThread light=true answers 200 for a row the full form\'s tx=1 would fail-stop on', () => {
    // Mirror the mock state used earlier in this file: a confirmed row whose
    // block holds no stored body — the full form's `tx=1` throws
    // `UnreadableStoredBlockError` (above), the light form reads no body.
    const state = {
      byId: new Map<string, StoredPost>(),
      page: [] as StoredPost[],
      pending: [] as StoredPost[],
      bodyBytesByHeight: new Map<number, Uint8Array>(),
      lastReadBytes: null as Uint8Array | null,
      pendingByTxId: new Map<string, Uint8Array>(),
      bodyReads: [] as number[],
      descendants: [] as StoredPost[],
      ancestors: [] as StoredPost[],
    };
    const { commit, postId, txId } = (() => {
      const id = makeTestIdentity();
      const { commit, tx, postId } = makePostTx(id, 'light bypasses the body read');
      return { commit, postId, txId: computeTxId(tx) };
    })();
    const row = storedPost({ id: postId, txId, commit, content: 'x', status: 'confirmed', blockHeight: 42, blockIndex: 0 });
    state.byId.set(postId, row);

    const feed = new FeedService({
      getPost: (id) => state.byId.get(id) ?? null,
      queryPostsPage: () => ({ rows: state.page, next: null, pending: state.pending, pendingCount: state.pending.length }),
      getLikeRecordCount: () => 0,
      getDescendantCount: () => 0,
      hasLikeRecord: () => false,
      getAncestorsNearest: () => ({ rows: state.ancestors, count: state.ancestors.length }),
      getSubtreePage: () => ({ rows: state.descendants, next: null, count: state.descendants.length, pending: state.pending, pendingCount: state.pending.length }),
      getBlockCreatedAt: () => null,
      getUsernameByOwner: () => null,
      getPendingUtxoTxBytesByTxId: (txId: TxId) => state.pendingByTxId.get(txId) ?? null,
      getUtxoTxTreeBytes: (height: number) => {
        state.bodyReads.push(height);
        return state.bodyBytesByHeight.get(height) ?? null;
      },
    });

    // Full form fail-stops.
    expect(() => feed.getThread(postId, { limit: 10 }, null, true)).toThrow();
    const beforeReads = state.bodyReads.length;
    const light = feed.getThread(postId, { limit: 10 }, null, false, true)!;
    expect((light.post as LightJson).kind).toBe('light');
    // The light form read no body at all.
    expect(state.bodyReads.length).toBe(beforeReads);
  });
});
