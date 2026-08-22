import { describe, it, expect } from 'vitest';
import { createPost, PostServiceError } from '../../src/services/post-service.js';
import type { PostServiceDeps } from '../../src/services/post-service.js';
import type { PostCommit, UtxoTransaction, AnyBox, KarmaBox } from '@dagsocial/types';
import type { StoredPost } from '../../src/store/posts.js';
import {
  PROTOCOL_VERSION, computePostId, computeTxId, computeContentHash,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Validate, don't trust — what that means once ids are provenance-derived
// ---------------------------------------------------------------------------

interface MockStore {
  posts: Set<string>;
}

const BOX_1 = '11'.repeat(32);
const BOX_2 = '22'.repeat(32);
const CONTENT = 'hello world';

function makeStore(): MockStore {
  return { posts: new Set() };
}

function makeStoredParent(id: string): StoredPost {
  return {
    id,
    content: `stored-parent:${id}`,
    contentHash: Buffer.from(computeContentHash(`stored-parent:${id}`)).toString('hex'),
    author: new Uint8Array(32),
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular',
    status: 'confirmed',
    blockHeight: null,
    blockIndex: null,
  };
}

function mockDeps(store: MockStore, overrides?: Partial<PostServiceDeps>): PostServiceDeps {
  return {
    verifyPost: (deps, commit) => {
      for (const ref of commit.parentRefs) {
        if (!deps.getPost(ref)) return { valid: false, error: `Parent post not found: ${ref}` };
      }
      return { valid: true };
    },
    getKarmaBoxes: () => [{ value: 100n }],
    getIdentityRecord: () => null,
    decayCfg: {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    },
    getPost: (id: string) => (store.posts.has(id) ? makeStoredParent(id) : null),
    insertPost: () => {},
    getCurrentHeight: () => 100,
    admitTx: () => 1,
    validateTx: (tx: UtxoTransaction) => ({ valid: true, txId: computeTxId(tx) }),
    getBox: () =>
      ({
        boxType: 'karma',
        value: 100n,
        owner: new Uint8Array(32),
      }) as AnyBox,
    runInTransaction: (fn: () => void) => fn(),
    ...overrides,
  };
}

function makeCommit(overrides?: Partial<PostCommit>): PostCommit {
  return {
    contentHash: computeContentHash(CONTENT),
    author: new Uint8Array(32),
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular',
    ...overrides,
  };
}

function makePostTx(commit: PostCommit = makeCommit(), input: string = BOX_1): UtxoTransaction {
  return {
    inputs: [input],
    outputs: [
      { boxType: 'karma', value: 75n, owner: new Uint8Array(32) } as KarmaBox,
      {
        boxType: 'post_lock', value: 25n, originalValue: 25n,
        owner: new Uint8Array(32),
      } as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: commit,
  };
}

describe('validate-dont-trust', () => {
  it('accepts a post whose parent exists', () => {
    const store = makeStore();
    const parentId = 'a1'.repeat(32);
    store.posts.add(parentId);

    const result = createPost(mockDeps(store), makePostTx(makeCommit({ parentRefs: [parentId] })), CONTENT);
    expect(result.status).toBe('pending');
  });

  it('rejects a post referencing a parent the store does not hold', () => {
    const store = makeStore();
    const nonexistent = 'a'.repeat(64);

    const tx = makePostTx(makeCommit({ parentRefs: [nonexistent] }));
    expect(() => createPost(mockDeps(store), tx, CONTENT)).toThrow(PostServiceError);
    expect(() => createPost(mockDeps(store), tx, CONTENT)).toThrow('Parent post not found');
  });

  it('⛔ a parent ref cannot be checked by recomputing the parent id', () => {
    const parent = makeStoredParent('b2'.repeat(32));
    expect(parent.id).toBe('b2'.repeat(32));
    const twin: StoredPost = { ...parent, id: 'c3'.repeat(32) };
    expect(twin.content).toBe(parent.content);
    expect(twin.id).not.toBe(parent.id);
  });

  it('computes the post id server-authoritatively — a client id has nowhere to go', () => {
    const store = makeStore();
    const tx = makePostTx();
    const withClaim = {
      ...tx,
      post: { ...tx.post!, postId: 'ff'.repeat(32), id: 'ee'.repeat(32) },
    } as unknown as UtxoTransaction;

    const honest = createPost(mockDeps(store), tx, CONTENT);
    const claimed = createPost(mockDeps(makeStore()), withClaim, CONTENT);

    expect(claimed.postId).toBe(honest.postId);
    expect(claimed.postId).not.toBe('ff'.repeat(32));
    expect(claimed.postId).toBe(computePostId(computeTxId(tx), 0));
  });

  it('produces different post ids for different content commitments', () => {
    const contentA = 'first';
    const contentB = 'second';
    const a = createPost(mockDeps(makeStore()), makePostTx(makeCommit({ contentHash: computeContentHash(contentA) })), contentA);
    const b = createPost(mockDeps(makeStore()), makePostTx(makeCommit({ contentHash: computeContentHash(contentB) })), contentB);
    expect(a.postId).not.toBe(b.postId);
  });

  it('produces different post ids for IDENTICAL content on different inputs', () => {
    const commit = makeCommit();
    const a = createPost(mockDeps(makeStore()), makePostTx(commit, BOX_1), CONTENT);
    const b = createPost(mockDeps(makeStore()), makePostTx(commit, BOX_2), CONTENT);
    expect(a.postId).not.toBe(b.postId);
  });

  it('accepts a root post with no parent refs', () => {
    const result = createPost(mockDeps(makeStore()), makePostTx(makeCommit({ parentRefs: [] })), CONTENT);
    expect(result.status).toBe('pending');
  });
});
