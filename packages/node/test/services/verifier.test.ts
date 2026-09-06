import { ByteKeyedMap } from '../helpers.js';
import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
} from 'crypto';
import {
  PROTOCOL_VERSION,
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  computeContentHash,
} from '@dagsocial/types';
import type { PostCommit } from '@dagsocial/types';
import type { StoredPost } from '../../src/store/posts.js';
import { verifyPost } from '../../src/services/verifier.js';
import type { VerifierDeps } from '../../src/services/verifier.js';

// ---------------------------------------------------------------------------
// Mock store helpers
// ---------------------------------------------------------------------------

interface MockStore {
  identities: ByteKeyedMap<{ userId: Uint8Array; publicKey: Uint8Array; createdAt: number }>;
  karmaBoxes: Map<string, { value: bigint }[]>;
  posts: Map<string, StoredPost>;
}

function createMockDeps(store: MockStore): VerifierDeps {
  return {
    getKarmaBoxes: (owner: Uint8Array) => {
      const hex = Buffer.from(owner).toString('hex');
      return store.karmaBoxes.get(hex) ?? [];
    },
    getIdentityRecord: () => null,
    currentHeight: 100,
    decayCfg: {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    },
    getPost: (id: string) => store.posts.get(id) ?? null,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyPost', () => {
  let pubKeyRaw: Uint8Array;
  let userId: Uint8Array;

  function makeStore(): MockStore {
    return {
      identities: new ByteKeyedMap(),
      karmaBoxes: new Map(),
      posts: new Map(),
    };
  }

  function makeCommit(overrides: Partial<PostCommit> = {}): PostCommit {
    return {
      contentHash: computeContentHash('hello world'),
      author: userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
      ...overrides,
    };
  }

  {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    pubKeyRaw = new Uint8Array(pubDer.slice(pubDer.length - 32));
    userId = pubKeyRaw;
  }

  it('valid commit passes all checks', () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: POST_PRICE_THREAD },
    ]);
    const commit = makeCommit();
    const deps = createMockDeps(store);
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects too many parent refs', () => {
    const store = makeStore();
    const commit = makeCommit({
      parentRefs: Array.from({ length: 9 }, (_, i) =>
        i.toString(16).padStart(2, '0').repeat(32),
      ),
    });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Too many parent refs');
  });

  it('rejects unsupported protocol version', () => {
    const store = makeStore();
    const commit = makeCommit({ protocolVersion: 99 });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Protocol version 99 is not the era 1');
  });

  it('rejects missing parent ref', () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: POST_PRICE_REPLY },
    ]);
    const ABSENT_PARENT = 'de'.repeat(32);
    const commit = makeCommit({ parentRefs: [ABSENT_PARENT] });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(`Parent post not found: ${ABSENT_PARENT}`);
  });

  it('accepts a parent ref that names a live post', () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: POST_PRICE_REPLY },
    ]);
    const parentId = 'ab'.repeat(32);
    store.posts.set(parentId, {
      id: parentId, content: 'parent', contentHash: Buffer.from(computeContentHash('parent')).toString('hex'),
      author: userId, parentRefs: [], protocolVersion: PROTOCOL_VERSION,
      type: 'regular', status: 'confirmed', blockHeight: 1, blockIndex: 0,
      withdrawnAtHeight: null,
    });
    const commit = makeCommit({ parentRefs: [parentId] });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(true);
  });

  it('accepts a parent ref that names a withdrawn post', () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: POST_PRICE_REPLY },
    ]);
    const withdrawnId = 'cd'.repeat(32);
    store.posts.set(withdrawnId, {
      id: withdrawnId, content: null, contentHash: Buffer.from(computeContentHash('withdrawn')).toString('hex'),
      author: userId, parentRefs: [], protocolVersion: PROTOCOL_VERSION,
      type: 'regular', status: 'confirmed', blockHeight: 1, blockIndex: 0,
      withdrawnAtHeight: 5,
    });
    const commit = makeCommit({ parentRefs: [withdrawnId] });
    const result = verifyPost(createMockDeps(store), commit);
    expect(result.valid).toBe(true);
  });

  it('rejects insufficient karma', () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [{ value: 1n }]);
    const commit = makeCommit();
    const deps = createMockDeps(store);
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient karma');
  });

  it('valid commit with 0 parent refs passes', () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: POST_PRICE_THREAD },
    ]);
    const commit = makeCommit({ parentRefs: [] });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts post when karma is split across multiple boxes', () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: 3n },
      { value: 2n },
    ]);
    const deps = createMockDeps(store);
    const commit = makeCommit();
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(true);
  });

  it('rejects post when combined karma across boxes is insufficient', () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: 2n },
      { value: 2n },
    ]);
    const deps = createMockDeps(store);
    const commit = makeCommit();
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient karma');
  });
});
