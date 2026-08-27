import { describe, it, expect } from 'vitest';
import { createPost, PostServiceError } from '../../src/services/post-service.js';
import type { PostServiceDeps } from '../../src/services/post-service.js';
import type { PostCommit, UtxoTransaction, AnyBox, KarmaBox } from '@dagsocial/types';
import {
  PROTOCOL_VERSION, computePostId, computeTxId, computeContentHash,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Minimal mock deps factory
// ---------------------------------------------------------------------------

function mockDeps(overrides?: Partial<PostServiceDeps>): PostServiceDeps {
  return {
    verifyPost: () => ({ valid: true }),
    getKarmaBoxes: () => [{ value: 100n }],
    getIdentityRecord: () => null,
    decayCfg: {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    },
    getPost: (id: string) => ({
      id, content: 'hello', contentHash: Buffer.from(computeContentHash('hello')).toString('hex'),
      author: new Uint8Array(32), parentRefs: [], protocolVersion: PROTOCOL_VERSION,
      type: 'regular' as const, status: 'confirmed' as const, blockHeight: null, blockIndex: null,
      withdrawnAtHeight: null,
    }),
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
    contentHash: computeContentHash('hello world'),
    author: new Uint8Array(32),
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular',
    ...overrides,
  };
}

const CONTENT = 'hello world';

const BOX_1 = '11'.repeat(32);
const BOX_2 = '22'.repeat(32);

function makePostTx(commit: PostCommit = makeCommit(), input: string = BOX_1): UtxoTransaction {
  return {
    inputs: [input],
    outputs: [
      {
        boxType: 'karma',
        value: 75n,
        owner: new Uint8Array(32),
      } as KarmaBox,
      {
        boxType: 'post_lock',
        value: 25n,
        originalValue: 25n,
        owner: new Uint8Array(32),
      } as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: commit,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostService', () => {
  it('returns pending result on successful post creation', () => {
    const deps = mockDeps();
    const tx = makePostTx();

    const result = createPost(deps, tx, CONTENT);

    expect(result.status).toBe('pending');
    expect(result.expiresAtHeight).toBeGreaterThan(0);
    expect(result.tx).toBe(tx);
  });

  it('⛔ names the post from the transaction that creates it, not from the post', () => {
    const deps = mockDeps();
    const tx = makePostTx();

    const result = createPost(deps, tx, CONTENT);

    expect(result.txId).toBe(computeTxId(tx));
    expect(result.postId).toBe(computePostId(computeTxId(tx), 0));
  });

  it('⛔ two identical payloads on different inputs get different post ids', () => {
    const commit = makeCommit();
    const first = makePostTx(commit);
    const second = makePostTx(commit, BOX_2);

    const a = createPost(mockDeps(), first, CONTENT);
    const b = createPost(mockDeps(), second, CONTENT);

    expect(a.postId).not.toBe(b.postId);
  });

  it('rejects a transaction carrying no post payload', () => {
    const deps = mockDeps();
    const { post: _post, ...noPost } = makePostTx();

    expect(() => createPost(deps, noPost as UtxoTransaction, CONTENT)).toThrow(PostServiceError);
    expect(() => createPost(deps, noPost as UtxoTransaction, CONTENT)).toThrow('carries no post payload');
  });

  it('rejects a body that fails verifyPostBody', () => {
    const deps = mockDeps();
    const tx = makePostTx();

    expect(() => createPost(deps, tx, 'wrong content')).toThrow(PostServiceError);
  });

  it('throws PostServiceError when verifyPost fails', () => {
    const deps = mockDeps({
      verifyPost: () => ({ valid: false, error: 'Content is empty' }),
    });
    const tx = makePostTx();

    expect(() => createPost(deps, tx, CONTENT)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx, CONTENT)).toThrow('Content is empty');
  });

  it('throws PostServiceError when transaction validation fails', () => {
    const deps = mockDeps({
      validateTx: () => ({ valid: false, error: 'Invalid signature' }),
    });
    const tx = makePostTx();

    expect(() => createPost(deps, tx, CONTENT)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx, CONTENT)).toThrow('Invalid signature');
  });

  it('throws PostServiceError when the transaction has no inputs', () => {
    const deps = mockDeps();
    const tx = makePostTx();
    tx.inputs = [];

    expect(() => createPost(deps, tx, CONTENT)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx, CONTENT)).toThrow('no inputs');
  });

  it('throws PostServiceError when first input is not a karma box', () => {
    const deps = mockDeps({
      getBox: () => ({ boxType: 'credit', value: 100n }) as AnyBox,
    });
    const tx = makePostTx();

    expect(() => createPost(deps, tx, CONTENT)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx, CONTENT)).toThrow('karma box');
  });

  it('throws PostServiceError when karma owner does not match post author', () => {
    const deps = mockDeps({
      getBox: () =>
        ({
          boxType: 'karma',
          value: 100n,
          owner: new Uint8Array(32).fill(0xaa),
        }) as AnyBox,
    });
    const tx = makePostTx();

    expect(() => createPost(deps, tx, CONTENT)).toThrow(PostServiceError);
    expect(() => createPost(deps, tx, CONTENT)).toThrow('does not belong to post author');
  });

  it('⛔ stores the post under the id the transaction gives it, and pools ONE entry', () => {
    const stored: Array<{ postId: string }> = [];
    let pooled = 0;
    const deps = mockDeps({
      insertPost: (postId: string) => { stored.push({ postId }); },
      admitTx: () => { pooled += 1; return 1; },
    });
    const tx = makePostTx();

    const result = createPost(deps, tx, CONTENT);

    expect(stored).toEqual([{ postId: result.postId }]);
    expect(pooled).toBe(1);
  });

  it('admitTx and insertPost run in one store transaction', () => {
    const callOrder: string[] = [];
    const deps = mockDeps({
      insertPost: () => { callOrder.push('insertPost'); },
      admitTx: () => { callOrder.push('admitTx'); return 1; },
      runInTransaction: (fn: () => void) => {
        callOrder.push('txStart');
        fn();
        callOrder.push('txEnd');
      },
    });
    const tx = makePostTx();

    createPost(deps, tx, CONTENT);

    expect(callOrder).toEqual(['txStart', 'admitTx', 'insertPost', 'txEnd']);
  });
});
