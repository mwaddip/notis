import { ByteKeyedMap, uid } from '../helpers.js';
import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { Post, Stump } from '@dagsocial/types';
import { verifyPost } from '../../src/services/verifier.js';
import type { VerifierDeps } from '../../src/services/verifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ⛔ **There is no PoW to solve and no post signature to build.** `verifyPost`
// checks the post PAYLOAD — field domains, content, parent existence, karma —
// and nothing else: a post is authenticated by the transaction that creates it,
// which is signed over its `TxId` by the author (NODE_INTERFACE → Post
// transactions). Reintroducing either here would be testing a rule the code no
// longer has.

// ---------------------------------------------------------------------------
// Mock store helpers
// ---------------------------------------------------------------------------

interface MockStore {
  // Byte-keyed, because the store they stand in for compares BLOBs by
  // value. `karmaBoxes` below already hex-keys; this one did not.
  identities: ByteKeyedMap<{ userId: Uint8Array; publicKey: Uint8Array; createdAt: number }>;
  karmaBoxes: Map<string, { value: bigint }[]>; // keyed by hex(owner publicKey), now an array
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
    getIdentityRecord: () => null,
    currentHeight: 100,
    decayCfg: {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    },
    getPost: (id: string) => store.posts.get(id) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyPost', () => {
  // Shared test fixtures
  let pubKeyRaw: Uint8Array;
  let privKey: KeyObject;
  let userId: Uint8Array;

  // Build a fresh mock store for each test
  function makeStore(): MockStore {
    return {
      identities: new ByteKeyedMap(),
      karmaBoxes: new Map(),
      posts: new Map(),
    };
  }

  /** A fully valid post payload with the given overrides. */
  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      content: 'hello world',
      author: userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
      ...overrides,
    };
  }

  // Generate a real Ed25519 keypair once for all tests
  {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    pubKeyRaw = new Uint8Array(pubDer.slice(pubDer.length - 32));
    // Keep KeyObject — crypto.sign needs it for Ed25519
    privKey = privateKey;
    userId = pubKeyRaw;
  }

  // -----------------------------------------------------------------------
  // 1. Valid post passes all checks
  // -----------------------------------------------------------------------
  it(
    'valid post passes all checks',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      // Populate store
      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_THREAD_COST },
      ]);
    const post = makePost();

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
  );

  // -----------------------------------------------------------------------
  // 2. Empty content
  // -----------------------------------------------------------------------
  it('rejects empty content', () => {
    const store = makeStore();
    const post = makePost({ content: '' });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  // -----------------------------------------------------------------------
  // 3. Content > 300 bytes
  // -----------------------------------------------------------------------
  it('rejects content exceeding max length', () => {
    const store = makeStore();
    const post = makePost({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content exceeds max length');
  });

  // -----------------------------------------------------------------------
  // 3b. Multi-byte content: over 300 UTF-8 bytes but within 300 code units
  // -----------------------------------------------------------------------
  it('rejects multi-byte content exceeding max UTF-8 byte length', () => {
    const store = makeStore();
    // 101 CJK characters: 1 UTF-16 code unit each, 3 UTF-8 bytes each = 303 bytes
    const post = makePost({ content: '一'.repeat(101) });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content exceeds max length');
  });

  // -----------------------------------------------------------------------
  // 4. > 8 parent refs
  // -----------------------------------------------------------------------
  it('rejects too many parent refs', () => {
    const store = makeStore();
    // Nine distinct well-formed PostIds. The subject here is the count rule, so
    // the refs must clear the step-0 domain pin to reach it — the old fixture
    // ('post0'…'post8') was never emittable by any producer, since a real PostId
    // is always `computePostId`'s 64-lowercase-hex digest.
    const post = makePost({
      parentRefs: Array.from({ length: 9 }, (_, i) =>
        i.toString(16).padStart(2, '0').repeat(32),
      ),
    });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Too many parent refs');
  });

  // -----------------------------------------------------------------------
  // 5. Wrong protocol version
  // -----------------------------------------------------------------------
  it('rejects unsupported protocol version', () => {
    const store = makeStore();
    const post = makePost({ protocolVersion: 99 });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Unsupported protocol version');
  });

  // -----------------------------------------------------------------------
  // 11. Missing parent ref
  // -----------------------------------------------------------------------
  it(
    'rejects missing parent ref',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_THREAD_COST },
      ]);

      // Reference a post that does not exist — reply needs POST_LOCK_REPLY_COST karma
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_REPLY_COST },
      ]);
      // A well-formed PostId that no post claims. It must be 64 lowercase hex:
      // a real PostId is always `computePostId`'s hex digest, and
      // `verifyPostFieldDomains` rejects anything else at step 0 — before this
      // test's actual subject, the step-8 parent-existence check, is reached.
      // A short non-hex id would therefore never reach that check, and no
      // producer could emit one.
      const ABSENT_PARENT = 'de'.repeat(32);
      let post = makePost({ parentRefs: [ABSENT_PARENT] });

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(`Parent post not found: ${ABSENT_PARENT}`);
    },
  );

  // -----------------------------------------------------------------------
  // 12. Insufficient karma
  // -----------------------------------------------------------------------
  it(
    'rejects insufficient karma',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      // Karma box value = 0, below POST_LOCK_THREAD_COST (5)
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [{ value: 0n }]);
    const post = makePost();

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Insufficient karma');
    },
  );

  // -----------------------------------------------------------------------
  // 13. Valid post with 0 parent refs passes
  // -----------------------------------------------------------------------
  it(
    'valid post with 0 parent refs passes',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_THREAD_COST },
      ]);

      // Explicitly empty parentRefs
    const post = makePost({ parentRefs: [] });

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
  );

  // -----------------------------------------------------------------------
  // 14. Multi-box karma sufficiency (split across boxes)
  // -----------------------------------------------------------------------
  it('accepts post when karma is split across multiple boxes', { timeout: 60_000 }, () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    // Two karma boxes: 3 + 2 = 5, enough for thread post
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: 3n },
      { value: 2n },
    ]);
    const deps = createMockDeps(store);
    const post = makePost();
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 15. Multi-box karma insufficiency (combined too low)
  // -----------------------------------------------------------------------
  it('rejects post when combined karma across boxes is insufficient', { timeout: 60_000 }, () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    // Two boxes with 2 + 2 = 4, but thread post costs 5
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: 2n },
      { value: 2n },
    ]);
    const deps = createMockDeps(store);
    const post = makePost();
    const result = verifyPost(deps, post);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient karma');
  });
});
