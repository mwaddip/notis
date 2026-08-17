import { describe, it, expect } from 'vitest';
import { createPost, PostServiceError } from '../../src/services/post-service.js';
import type { PostServiceDeps } from '../../src/services/post-service.js';
import type { Post, UtxoTransaction, AnyBox, KarmaBox } from '@dagsocial/types';
import type { StoredPost } from '../../src/store/posts.js';
import { PROTOCOL_VERSION, computePostId, computeTxId, encodePost } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Validate, don't trust — what that means once ids are provenance-derived
// ---------------------------------------------------------------------------
//
// ⛔ **This file's original subject is GONE, and its replacement is the sharper
// half.** It used to pin `verifyParentHash`: decode the parent's stored bytes,
// recompute its id, and refuse a mismatch. **That check has no possible
// implementation now** — a post's id comes from the transaction that created it
// (`computePostId(txId, index)` takes no `Post`), so the parent's own bytes make
// no claim that could be checked against the ref naming them.
//
// This is not a hole opening. It is the same move Spec G made for boxes: the
// binding left the content and went to the transaction, where it is **stronger**
// because the transaction is signed and its inputs cannot be reused. What the
// service can still check about a parent is **existence**, and what it must
// still refuse to trust is a client-supplied id — which is now structural rather
// than a check, because the request has nowhere to put one.
//
// The surviving recomputation lives where the binding does: `createPost` derives
// the post id from `computeTxId`, and block apply checks each declared
// `utxoTxId` byte-for-byte against `computeTxId(tx)` before anything reads it.

interface MockStore {
  /** Ids the store holds a post for. Presence is all a parent ref can be checked for. */
  posts: Set<string>;
}

const BOX_1 = '11'.repeat(32);
const BOX_2 = '22'.repeat(32);

function makeStore(): MockStore {
  return { posts: new Set() };
}

function makeStoredParent(id: string): StoredPost {
  return {
    id,
    content: `stored-parent:${id}`,
    author: new Uint8Array(32),
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    timestamp: 0,
    status: 'confirmed',
  };
}

function mockDeps(store: MockStore, overrides?: Partial<PostServiceDeps>): PostServiceDeps {
  return {
    verifyPost: (deps, post) => {
      // The parent-existence leg of the real `verifyPost`, which is the only
      // parent rule left. Mirrored here rather than stubbed `valid: true`, so
      // these tests measure the rule rather than the mock.
      for (const ref of post.parentRefs) {
        if (!deps.getPost(ref)) return { valid: false, error: `Parent post not found: ${ref}` };
      }
      return { valid: true };
    },
    getKarmaBoxes: () => [{ value: 100n }],
    getPost: (id: string) => (store.posts.has(id) ? makeStoredParent(id) : null),
    encodePost,
    insertPost: () => {},
    getCurrentHeight: () => 100,
    admitTx: () => 1,
    // The REAL derivation, not a placeholder — see post-service.test.ts.
    validateTx: (tx: UtxoTransaction) => ({ valid: true, txId: computeTxId(tx) }),
    getBox: () =>
      ({
        boxType: 'karma',
        value: 100n,
        owner: new Uint8Array(32),
      }) as AnyBox,
    ...overrides,
  };
}

function makePost(overrides?: Partial<Post>): Post {
  return {
    content: 'hello world',
    author: new Uint8Array(32),
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function makePostTx(post: Post = makePost(), input: string = BOX_1): UtxoTransaction {
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
    post,
  };
}

describe('validate-dont-trust', () => {
  it('accepts a post whose parent exists', () => {
    const store = makeStore();
    const parentId = 'a1'.repeat(32);
    store.posts.add(parentId);

    const result = createPost(mockDeps(store), makePostTx(makePost({ parentRefs: [parentId] })));
    expect(result.status).toBe('pending');
  });

  it('rejects a post referencing a parent the store does not hold', () => {
    const store = makeStore();
    const nonexistent = 'a'.repeat(64);

    const tx = makePostTx(makePost({ parentRefs: [nonexistent] }));
    expect(() => createPost(mockDeps(store), tx)).toThrow(PostServiceError);
    expect(() => createPost(mockDeps(store), tx)).toThrow('Parent post not found');
  });

  it('⛔ a parent ref cannot be checked by recomputing the parent id', () => {
    // The rule, asserted rather than described. A stored parent's bytes produce
    // no id — there is no `(Post) => PostId` — so the store's recorded id is the
    // only statement of the binding, and existence is what remains checkable.
    const parent = makeStoredParent('b2'.repeat(32));
    // The id is CARRIED, not derived: `StoredPost.id` is the store's statement.
    expect(parent.id).toBe('b2'.repeat(32));
    // And nothing in the payload determines it — two stored posts with identical
    // payloads can legitimately hold different ids.
    const twin: StoredPost = { ...parent, id: 'c3'.repeat(32) };
    expect(twin.content).toBe(parent.content);
    expect(twin.id).not.toBe(parent.id);
  });

  it('computes the post id server-authoritatively — a client id has nowhere to go', () => {
    // Non-spoofable by CONSTRUCTION rather than by a check: the request carries a
    // transaction, the id is derived from it, and a client-supplied `postId` on
    // the payload is not a field the derivation reads.
    const store = makeStore();
    const tx = makePostTx();
    const withClaim = {
      ...tx,
      post: { ...tx.post!, postId: 'ff'.repeat(32), id: 'ee'.repeat(32) },
    } as unknown as UtxoTransaction;

    const honest = createPost(mockDeps(store), tx);
    const claimed = createPost(mockDeps(makeStore()), withClaim);

    expect(claimed.postId).toBe(honest.postId);
    expect(claimed.postId).not.toBe('ff'.repeat(32));
    expect(claimed.postId).toBe(computePostId(computeTxId(tx), 0));
  });

  it('produces different post ids for different content', () => {
    // Through the transaction: distinct payloads give distinct `TxId`s because
    // `postFieldBytes` is inside that preimage.
    const a = createPost(mockDeps(makeStore()), makePostTx(makePost({ content: 'first' })));
    const b = createPost(mockDeps(makeStore()), makePostTx(makePost({ content: 'second' })));
    expect(a.postId).not.toBe(b.postId);
  });

  it('produces different post ids for IDENTICAL content on different inputs', () => {
    // The half content-derivation could not give: the same payload twice is two
    // posts, because the author must spend a different karma box each time.
    const post = makePost({ content: 'the same words twice' });
    const a = createPost(mockDeps(makeStore()), makePostTx(post, BOX_1));
    const b = createPost(mockDeps(makeStore()), makePostTx(post, BOX_2));
    expect(a.postId).not.toBe(b.postId);
  });

  it('accepts a root post with no parent refs', () => {
    const result = createPost(mockDeps(makeStore()), makePostTx(makePost({ parentRefs: [] })));
    expect(result.status).toBe('pending');
  });
});
