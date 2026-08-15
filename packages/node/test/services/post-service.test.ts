import { describe, it, expect } from 'vitest';
import { createPost, PostServiceError } from '../../src/services/post-service.js';
import type { PostServiceDeps } from '../../src/services/post-service.js';
import type { Post, UtxoTransaction, AnyBox, KarmaBox } from '@dagsocial/types';
import { PROTOCOL_VERSION, computePostId, computeTxId } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Minimal mock deps factory
// ---------------------------------------------------------------------------

function mockDeps(overrides?: Partial<PostServiceDeps>): PostServiceDeps {
  return {
    verifyPost: () => ({ valid: true }),
    getKarmaBoxes: () => [{ value: 100n }],
    // `(id) => StoredPost | Stump | null`. These tests only need presence, so
    // return a real stored post — carrying the `id` the store now supplies.
    getPost: (id: string) => ({ ...makePost({ content: 'hello' }), id, status: 'confirmed' as const }),
    encodePost: () => new Uint8Array(10),
    insertPost: () => {},
    getCurrentHeight: () => 100,
    insertUtxoTx: () => 1,
    // ⛔ The mock returns the txId the REAL `computeTxId` gives the fixture, not
    // a placeholder. `createPost` derives the post id from whatever `validateTx`
    // hands back, so a stand-in string here would let the assertions below pass
    // against arithmetic the production path could never produce.
    validateTx: (tx: UtxoTransaction) => ({ valid: true, txId: computeTxId(tx) }),
    getBox: () =>
      ({
        boxType: 'karma',
        value: 100n,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
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

/**
 * ⛔ **One transaction, carrying its post.** There is no separate post object
 * and no `karmaLockTx` beside it — they were always one intent, and the mempool
 * `batchId` existed only to paper over the split.
 */
const BOX_1 = '11'.repeat(32);
const BOX_2 = '22'.repeat(32);

/**
 * ⚠ **Inputs must be real 64-hex box ids now, and that is not cosmetic.** The
 * old fixture used `'box-1'`: nothing computed the transaction's id, so a
 * placeholder was invisible. `createPost` now derives the post id from
 * `computeTxId`, which writes inputs with a throwing fixed-width writer — a
 * placeholder is an exception rather than a wrong-looking id.
 */
function makePostTx(post: Post = makePost(), input: string = BOX_1): UtxoTransaction {
  return {
    inputs: [input],
    outputs: [
      {
        boxType: 'karma',
        value: 75n,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
      } as KarmaBox,
      {
        boxType: 'post_lock',
        value: 25n,
        originalValue: 25n,
        owner: new Uint8Array(32),
        guard: 'block_apply',
      } as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostService', () => {
  it('returns pending result on successful post creation', () => {
    const deps = mockDeps();
    const tx = makePostTx();

    const result = createPost(deps, tx);

    expect(result.status).toBe('pending');
    expect(result.expiresAtHeight).toBeGreaterThan(0);
    expect(result.tx).toBe(tx);
  });

  it('⛔ names the post from the transaction that creates it, not from the post', () => {
    // The claim this file owns, and the reason the mock returns a real
    // `computeTxId`: the id `createPost` reports must be exactly
    // `computePostId(txId, 0)` of the transaction it was handed. Recomputed
    // here from the transaction rather than from the post — which is the only
    // way it CAN be recomputed.
    const deps = mockDeps();
    const tx = makePostTx();

    const result = createPost(deps, tx);

    expect(result.txId).toBe(computeTxId(tx));
    expect(result.postId).toBe(computePostId(computeTxId(tx), 0));
  });

  it('⛔ two identical payloads on different inputs get different post ids', () => {
    // spec §7. The property `challenge` and `powNonce` used to buy, now bought
    // by construction — the transactions differ in `inputs` alone.
    const post = makePost();
    const first = makePostTx(post);
    const second = makePostTx(post, BOX_2);

    const a = createPost(mockDeps(), first);
    const b = createPost(mockDeps(), second);

    expect(a.postId).not.toBe(b.postId);
  });

  it('rejects a transaction carrying no post payload', () => {
    const deps = mockDeps();
    const { post: _post, ...noPost } = makePostTx();

    expect(() => createPost(deps, noPost as UtxoTransaction)).toThrow(PostServiceError);
    expect(() => createPost(deps, noPost as UtxoTransaction)).toThrow('carries no post payload');
  });

  it('throws PostServiceError when verifyPost fails', () => {
    const deps = mockDeps({
      verifyPost: () => ({ valid: false, error: 'Content is empty' }),
    });
    const tx = makePostTx();

    expect(() => createPost(deps, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx)).toThrow('Content is empty');
  });

  it('throws PostServiceError when transaction validation fails', () => {
    const deps = mockDeps({
      validateTx: () => ({ valid: false, error: 'Invalid signature' }),
    });
    const tx = makePostTx();

    expect(() => createPost(deps, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx)).toThrow('Invalid signature');
  });

  it('throws PostServiceError when the transaction has no inputs', () => {
    const deps = mockDeps();
    const tx = makePostTx();
    tx.inputs = [];

    expect(() => createPost(deps, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx)).toThrow('no inputs');
  });

  it('throws PostServiceError when first input is not a karma box', () => {
    const deps = mockDeps({
      getBox: () => ({ boxType: 'credit', value: 100n }) as AnyBox,
    });
    const tx = makePostTx();

    expect(() => createPost(deps, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx)).toThrow('karma box');
  });

  it('throws PostServiceError when karma owner does not match post author', () => {
    // Authorship binding: without it one identity could publish a post
    // attributed to another while paying from its own karma, and prune and the
    // feed both key on `post.author`.
    const deps = mockDeps({
      getBox: () =>
        ({
          boxType: 'karma',
          value: 100n,
          owner: new Uint8Array(32).fill(0xaa),
        }) as AnyBox,
    });
    const tx = makePostTx();

    expect(() => createPost(deps, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx)).toThrow('does not belong to post author');
  });

  it('⛔ stores the post under the id the transaction gives it, and pools ONE entry', () => {
    // The mempool `batchId` is gone with the pair it regrouped: one intent, one
    // transaction, one entry. Asserting the count is what would catch a
    // reintroduced second insert.
    const stored: Array<{ postId: string }> = [];
    let pooled = 0;
    const deps = mockDeps({
      insertPost: (postId: string) => { stored.push({ postId }); },
      insertUtxoTx: () => { pooled += 1; return 1; },
    });
    const tx = makePostTx();

    const result = createPost(deps, tx);

    expect(stored).toEqual([{ postId: result.postId }]);
    expect(pooled).toBe(1);
  });
});
