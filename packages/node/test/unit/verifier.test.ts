import { ByteKeyedMap } from '../helpers.js';
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  PROTOCOL_VERSION,
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
// Helpers
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

function makeStore(): MockStore {
  return {
    identities: new ByteKeyedMap(),
    karmaBoxes: new Map(),
    posts: new Map(),
  };
}

describe('verifier', () => {
  let userId: Uint8Array;

  {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    userId = new Uint8Array(pubDer.slice(pubDer.length - 32));
  }

  function makeCommit(overrides: Partial<PostCommit> = {}): PostCommit {
    return {
      contentHash: computeContentHash('hello'),
      author: userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
      ...overrides,
    };
  }

  it('rejects commit with unsupported protocol version', () => {
    const store = makeStore();
    const commit = makeCommit({ protocolVersion: 99 });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, commit);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Protocol version 99 is not the era 1');
  });

  it('⛔ accepts a commit with no signature and no proof of work', () => {
    const store = makeStore();
    store.karmaBoxes.set(Buffer.from(userId).toString('hex'), [{ value: 100n }]);
    const commit = makeCommit();
    expect(Object.keys(commit).sort()).toEqual(
      ['author', 'contentHash', 'parentRefs', 'protocolVersion', 'type'],
    );

    const result = verifyPost(createMockDeps(store), commit);
    expect(result).toEqual({ valid: true });
  });

  it('rejects a parent ref no stored post answers to', () => {
    const store = makeStore();
    store.karmaBoxes.set(Buffer.from(userId).toString('hex'), [{ value: 100n }]);
    const missing = 'ab'.repeat(32);
    const result = verifyPost(createMockDeps(store), makeCommit({ parentRefs: [missing] }));
    expect(result.valid).toBe(false);
    expect(result.error).toBe(`Parent post not found: ${missing}`);
  });

  it('accepts a parent ref that names a withdrawn post', () => {
    const store = makeStore();
    store.karmaBoxes.set(Buffer.from(userId).toString('hex'), [{ value: 100n }]);
    const withdrawnId = 'cd'.repeat(32);
    store.posts.set(withdrawnId, {
      id: withdrawnId,
      content: null,
      contentHash: Buffer.from(computeContentHash('withdrawn')).toString('hex'),
      author: userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
      status: 'confirmed',
      blockHeight: 1,
      blockIndex: 0,
      withdrawnAtHeight: 5,
    });
    const result = verifyPost(createMockDeps(store), makeCommit({ parentRefs: [withdrawnId] }));
    expect(result).toEqual({ valid: true });
  });

  it('rejects an author holding no karma', () => {
    const result = verifyPost(createMockDeps(makeStore()), makeCommit());
    expect(result.valid).toBe(false);
    expect(result.error).toBe('No karma box found');
  });
});
