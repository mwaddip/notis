import { ByteKeyedMap } from '../helpers.js';
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { Post, Stump } from '@dagsocial/types';
import { verifyPost } from '../../src/services/verifier.js';
import type { VerifierDeps } from '../../src/services/verifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockStore {
  // Byte-keyed, because the store they stand in for compares BLOBs by
  // value. A plain `Map` keyed on a `Uint8Array` compares by reference, so a
  // lookup with an equal-but-distinct array misses. `karmaBoxes` reaches the
  // same property by hex-keying.
  identities: ByteKeyedMap<{ userId: Uint8Array; publicKey: Uint8Array; createdAt: number }>;
  karmaBoxes: Map<string, { value: bigint }[]>;
  // Typed as what the dep must return, not `unknown`. Nothing is ever put
  // in it — `getPost` returns null throughout these suites — but a mock
  // whose value type cannot satisfy the interface is a mock that would
  // not compile the day a test starts using it.
  posts: Map<string, Post | Stump>;
}

function createMockDeps(store: MockStore): VerifierDeps {
  return {
    getKarmaBoxes: (owner: Uint8Array) => {
      const hex = Buffer.from(owner).toString('hex');
      return store.karmaBoxes.get(hex) ?? [];
    },
    getPost: (id: string) => store.posts.get(id) ?? null,
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

  // A real Ed25519 public key, because `author` is a 32-byte fixed-width field
  // and `verifyPostFieldDomains` runs first (VALIDATION_INTERFACE →
  // verifyPostFieldDomains). The private half is not generated: nothing here
  // signs anything.
  {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    userId = new Uint8Array(pubDer.slice(pubDer.length - 32));
  }

  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      content: 'hello',
      author: userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      timestamp: 1700000000000,
      ...overrides,
    };
  }

  it('rejects post with unsupported protocol version', () => {
    const store = makeStore();
    const post = makePost({ protocolVersion: 99 });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Unsupported protocol version');
  });

  it('rejects post with content exceeding max length', () => {
    const store = makeStore();
    const longContent = 'x'.repeat(301);
    const post = makePost({ content: longContent });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content exceeds max length');
  });

  it('rejects post with empty content', () => {
    const store = makeStore();
    const post = makePost({ content: '' });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  it('accepts a payload carrying no signature and no proof of work', () => {
    // ⛔ The POSITIVE half of the removal. Every other case here rejects, so a
    // reintroduced signature or PoW gate would leave them all green — this is
    // the one that fails if one comes back, and it asserts `valid` rather than
    // an absent error string so a new gate cannot pass it by rejecting for a
    // reason no case names.
    const store = makeStore();
    store.karmaBoxes.set(Buffer.from(userId).toString('hex'), [{ value: 100n }]);
    const post = makePost();
    expect(Object.keys(post).sort()).toEqual(
      ['author', 'content', 'parentRefs', 'protocolVersion', 'timestamp'],
    );

    const result = verifyPost(createMockDeps(store), post);
    expect(result).toEqual({ valid: true });
  });

  it('rejects a parent ref no stored post answers to', () => {
    // The check that replaced parent-hash recomputation: a post id is
    // provenance-derived, so the store's record is the only statement of it and
    // existence is what stays checkable (NODE_INTERFACE → Post transactions).
    const store = makeStore();
    store.karmaBoxes.set(Buffer.from(userId).toString('hex'), [{ value: 100n }]);
    const missing = 'ab'.repeat(32);
    const result = verifyPost(createMockDeps(store), makePost({ parentRefs: [missing] }));
    expect(result.valid).toBe(false);
    expect(result.error).toBe(`Parent post not found: ${missing}`);
  });

  it('rejects an author holding no karma', () => {
    // The early, friendlier half of the lock. The enforcement point is the
    // engine's post biconditional, which a block re-validates — this rejects
    // before a doomed transaction is ever built.
    const result = verifyPost(createMockDeps(makeStore()), makePost());
    expect(result.valid).toBe(false);
    expect(result.error).toBe('No karma box found');
  });
});
